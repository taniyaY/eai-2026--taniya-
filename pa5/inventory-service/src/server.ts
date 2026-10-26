import type {ConsumeMessage} from "amqplib";
import {connectWithRetry,getRetryCount} from "../../shared/rabbit";
import type {CanonicalOrder} from "../../shared/canonical-order";
async function setupFaultChannels(channel: import("amqplib").Channel) {
 for(const [exchange, queue] of [["orders.dlq.exchange","orders.dlq"],["orders.invalid.exchange","orders.invalid"]]) {
  await channel.assertExchange(exchange,"fanout",{durable:true});
  await channel.assertQueue(queue,{durable:true});
  await channel.bindQueue(queue,exchange,"");
 }
}
async function start() {
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.prefetch(1);
 await setupFaultChannels(channel);
 const limit=Number(process.env.MAX_RETRIES??"3");
 const failurePercent=Number(process.env.INVENTORY_FAIL_RATE??"10");
 await channel.consume("inventory.queue",async(message:ConsumeMessage|null)=>{
  if(!message)return;
  const headers=message.properties.headers??{};
  const correlationId=headers.correlationId as string|undefined;
  try {
   const order=JSON.parse(message.content.toString("utf8")) as CanonicalOrder;
   if(!correlationId || typeof order?.orderId!=="string")throw new SyntaxError("Missing order identity");
   if(Math.random()*100<failurePercent)throw new Error("inventory temporarily unavailable");
   const event={correlationId,source:"inventory",status:"success",timestamp:new Date().toISOString(),details:{message:"inventory accepted the order"}};
   channel.publish("results.inventory","",Buffer.from(JSON.stringify(event)),{headers:{correlationId},persistent:true,contentType:"application/json"});
   channel.ack(message);
  }catch(error) {
   if(error instanceof SyntaxError){
    channel.publish("orders.invalid.exchange","",message.content,{headers,persistent:true});
    channel.ack(message);
   }else if(getRetryCount(message)+1>=limit){
    channel.publish(process.env.DLQ_EXCHANGE??"orders.dlq.exchange","",message.content,{headers:{...headers,originQueue:"inventory.queue"},persistent:true});
    channel.ack(message);
   }else channel.nack(message,false,false);
  }
 });
 console.log("inventory ready");
}
start().catch(console.error);
