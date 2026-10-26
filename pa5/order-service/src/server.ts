import express from "express";
import {randomUUID} from "node:crypto";
import {connectWithRetry,withoutRetryHistory} from "../../shared/rabbit";
import type {CanonicalOrder} from "../../shared/canonical-order";
async function start(){
 const {channel}=await connectWithRetry(process.env.RABBITMQ_URL!);
 await channel.assertExchange("orders.dlq.exchange","fanout",{durable:true});
 await channel.assertQueue("orders.dlq",{durable:true});
 await channel.bindQueue("orders.dlq","orders.dlq.exchange","");
 const history=new Map<string,CanonicalOrder>();
 const app=express();
 app.use(express.json());
 app.get("/health",(_request,response)=>response.json({status:"ok"}));
 app.post("/orders",(request,response)=>{
  const order=request.body as CanonicalOrder;
  if(!order || typeof order.orderId!=="string" || !order.customer || !Array.isArray(order.items)){response.status(400).json({error:"Invalid order"});return;}
  const correlationId=randomUUID();
  channel.publish("orders.exchange","",Buffer.from(JSON.stringify(order)),{headers:{correlationId},persistent:true,contentType:"application/json"});
  history.set(correlationId,order);
  response.status(201).json({correlationId,status:"accepted"});
 });
 app.get("/orders/:correlationId",(request,response)=>{
  const order=history.get(request.params.correlationId);
  if(!order){response.status(404).json({error:"Unknown correlation ID"});return;}
  response.json({correlationId:request.params.correlationId,order});
 });
 app.post("/dlq/replay",async(_request,response)=>{
  let replayed=0;
  try{
   for(;;){
    const message=await channel.get("orders.dlq",{noAck:false});
    if(!message)break;
    const origin=message.properties.headers?.originQueue;
    if(typeof origin!=="string" || !["payments.queue","inventory.queue","notifications.queue"].includes(origin)){channel.nack(message,false,true);throw new Error("Unknown origin queue");}
    const headers=withoutRetryHistory(message.properties.headers);
    delete headers.originQueue;
    channel.publish("orders.return.exchange",origin,message.content,{headers,persistent:true,contentType:message.properties.contentType||"application/json"});
    channel.ack(message);
    replayed++;
   }
   response.json({replayed});
  }catch(error){response.status(500).json({error:String(error),replayed});}
 });
 app.listen(Number(process.env.PORT??"3000"),"0.0.0.0");
}
start().catch(console.error);
