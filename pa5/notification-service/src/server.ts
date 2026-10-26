import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync} from "node:fs";
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
async function start(){
 mkdirSync("/data",{recursive:true});
 const path="/data/processed-ids.json";
 if(!existsSync(path))writeFileSync(path,"[]");
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.prefetch(1);
 await setupFaultChannels(channel);
 await channel.consume("notifications.queue",async(message:ConsumeMessage|null)=>{
  if(!message)return;
  const headers=message.properties.headers??{};
  const correlationId=headers.correlationId as string|undefined;
  try{
   const order=JSON.parse(message.content.toString("utf8")) as CanonicalOrder;
   if(!correlationId||typeof order?.orderId!=="string"||typeof order.customer?.email!=="string")throw new SyntaxError("Malformed notification order");
   const processed=new Set<string>(JSON.parse(readFileSync(path,"utf8")));
   if(processed.has(correlationId)){channel.ack(message);console.log("duplicate skipped");return;}
   appendFileSync("/data/notification.log",JSON.stringify({correlationId,orderId:order.orderId,customerEmail:order.customer.email,timestamp:new Date().toISOString(),message:"Order received"})+"\n");
   processed.add(correlationId);
   writeFileSync(path,JSON.stringify([...processed]));
   channel.publish("results.notification","",Buffer.from(JSON.stringify({correlationId,source:"notification",status:"success",timestamp:new Date().toISOString(),details:{message:"Order received"}})),{headers:{correlationId},contentType:"application/json",persistent:true});
   channel.ack(message);
  }catch(error){
   if(error instanceof SyntaxError){channel.publish("orders.invalid.exchange","",message.content,{headers,persistent:true});channel.ack(message);}
   else if(getRetryCount(message)+1>=Number(process.env.MAX_RETRIES??"3")){channel.publish(process.env.DLQ_EXCHANGE??"orders.dlq.exchange","",message.content,{headers:{...headers,originQueue:"notifications.queue"},persistent:true});channel.ack(message);}
   else channel.nack(message,false,false);
  }
 });
}
start().catch(console.error);
