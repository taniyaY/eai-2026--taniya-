"""
PA3 router service.

The service receives a whole order, splits its items into individual
messages, then chooses a destination queue from each item's type.
"""

import json
import os

import pika


TYPE_TO_QUEUE = {
    "physical": "orders.physical",
    "digital": "orders.digital",
    "subscription": "orders.subscription",
}


def rabbit_connection():
    host = os.getenv("RABBITMQ_HOST", "localhost")
    return pika.BlockingConnection(pika.ConnectionParameters(host=host))


def make_item_message(order, position, item):
    """Create the message passed to a downstream worker."""
    return {
        "orderId": order["orderId"],
        "correlationId": order["orderId"],
        "itemIndex": position,
        "totalItems": len(order.get("items", [])),
        "item": item,
    }


def publish_item(channel, queue_name, message):
    channel.basic_publish(
        exchange="",
        routing_key=queue_name,
        body=json.dumps(message),
        properties=pika.BasicProperties(delivery_mode=2),
    )


def handle_order(ch, method, properties, body):
    order = json.loads(body)
    items = order.get("items", [])

    out_connection = rabbit_connection()
    out_channel = out_connection.channel()

    for queue_name in TYPE_TO_QUEUE.values():
        out_channel.queue_declare(queue=queue_name, durable=True)

    for position, item in enumerate(items):
        item_type = item.get("type")
        destination = TYPE_TO_QUEUE.get(item_type)

        if destination is None:
            print(
                f"[router] order={order['orderId']} item={position} "
                f"has unsupported type={item_type!r}; item skipped"
            )
            continue

        message = make_item_message(order, position, item)
        publish_item(out_channel, destination, message)

        print(
            f"[router] order={order['orderId']} item={position} "
            f"type={item_type} -> {destination}"
        )

    out_connection.close()
    ch.basic_ack(delivery_tag=method.delivery_tag)


def main():
    connection = rabbit_connection()
    channel = connection.channel()

    channel.queue_declare(queue="orders.incoming", durable=True)
    channel.basic_qos(prefetch_count=1)
    channel.basic_consume(
        queue="orders.incoming",
        on_message_callback=handle_order,
    )

    print("[router] waiting for orders")
    channel.start_consuming()


if __name__ == "__main__":
    main()
