"""
PA3 aggregator service.

Results are kept per order until every item arrives or the order has been
idle for too long.  itemIndex is used as the deduplication key.
"""

import json
import os
import threading
import time

import pika


IDLE_TIMEOUT_SECONDS = float(
    os.getenv("AGGREGATOR_IDLE_TIMEOUT_SECONDS", "5")
)
SWEEP_INTERVAL_SECONDS = 0.5

orders = {}
finished = set()
state_lock = threading.Lock()


def rabbit_connection():
    host = os.getenv("RABBITMQ_HOST", "localhost")
    return pika.BlockingConnection(pika.ConnectionParameters(host=host))


def completion_payload(order_id, record, status):
    expected = record["total"]
    results = record["results"]

    missing = [
        index
        for index in range(expected)
        if index not in results
    ]

    return {
        "orderId": order_id,
        "correlationId": record["correlationId"],
        "status": status,
        "totalItems": expected,
        "receivedItems": len(results),
        "itemResults": [
            results[index] for index in sorted(results)
        ],
        "missingItemIndexes": missing,
    }


def send_completion(payload):
    connection = rabbit_connection()
    channel = connection.channel()
    channel.queue_declare(queue="orders.complete", durable=True)

    channel.basic_publish(
        exchange="",
        routing_key="orders.complete",
        body=json.dumps(payload),
        properties=pika.BasicProperties(delivery_mode=2),
    )
    connection.close()


def handle_result(ch, method, properties, body):
    final_message = None

    try:
        result = json.loads(body)

        order_id = result["orderId"]
        correlation_id = result["correlationId"]
        item_index = result["itemIndex"]
        total_items = result["totalItems"]

        if (
            not isinstance(item_index, int)
            or not isinstance(total_items, int)
            or total_items <= 0
            or item_index < 0
            or item_index >= total_items
        ):
            raise ValueError("invalid itemIndex or totalItems")

        with state_lock:
            if order_id in finished:
                print(
                    f"[aggregator] ignoring late result "
                    f"order={order_id} item={item_index}"
                )
            else:
                record = orders.setdefault(
                    order_id,
                    {
                        "correlationId": correlation_id,
                        "total": total_items,
                        "results": {},
                        "last_seen": time.monotonic(),
                    },
                )

                # A duplicate has the same key, so it replaces rather than
                # increases the number of collected results.
                record["results"][item_index] = result
                record["last_seen"] = time.monotonic()

                if len(record["results"]) == record["total"]:
                    final_message = completion_payload(
                        order_id, record, "complete"
                    )
                    orders.pop(order_id, None)
                    finished.add(order_id)

        if final_message is not None:
            send_completion(final_message)
            print(f"[aggregator] complete order={order_id}")

    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        print(f"[aggregator] rejected malformed result: {error}")

    finally:
        ch.basic_ack(delivery_tag=method.delivery_tag)


def timeout_watcher():
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        now = time.monotonic()
        expired = []

        with state_lock:
            for order_id, record in list(orders.items()):
                idle_seconds = now - record["last_seen"]

                if idle_seconds >= IDLE_TIMEOUT_SECONDS:
                    expired.append(
                        completion_payload(order_id, record, "partial")
                    )
                    orders.pop(order_id, None)
                    finished.add(order_id)

        for payload in expired:
            send_completion(payload)
            print(
                f"[aggregator] partial order={payload['orderId']} "
                f"missing={payload['missingItemIndexes']}"
            )


def main():
    connection = rabbit_connection()
    channel = connection.channel()

    channel.queue_declare(queue="orders.results", durable=True)
    channel.queue_declare(queue="orders.complete", durable=True)
    channel.basic_qos(prefetch_count=1)

    threading.Thread(
        target=timeout_watcher,
        daemon=True,
    ).start()

    channel.basic_consume(
        queue="orders.results",
        on_message_callback=handle_result,
    )

    print("[aggregator] waiting for item results")
    channel.start_consuming()


if __name__ == "__main__":
    main()
