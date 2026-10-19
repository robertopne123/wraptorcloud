import {NextResponse} from 'next/server';
import {verifyProxy} from '@/lib/race-day/core';
import {config} from '@/lib/race-day/shopify';
import {clientHash,configured,listGallery,prepareUpload,submitUpload} from '@/lib/race-day/gallery';
export const runtime='nodejs';
export const maxDuration=30;
const response=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function body(request:Request){if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('Use a JSON request.');const text=await request.text();if(text.length>6000)throw new Error('Request is too large.');return JSON.parse(text);}
async function handle(request:Request){const url=new URL(request.url),path=url.pathname.replace('/api/race-day','');if(request.method==='GET'&&path==='/health')return response({ok:true,configured:configured()});if(!configured())return response({error:'Gallery uploads are not connected yet.'},503);if(!verifyProxy(url.searchParams,config.secret!,config.shop))return response({error:'This request must come through the connected Shopify store.'},401);
 try{if(request.method==='GET'&&path==='/gallery')return response(await listGallery(url.searchParams.get('after')));if(request.method==='POST'&&path==='/uploads')return response(await prepareUpload(await body(request),clientHash(request)));if(request.method==='POST'&&path==='/submissions'){const data=await body(request);return response(await submitUpload(data.token));}return response({error:'Not found.'},404);}catch(error){const message=error instanceof Error?error.message:'Unknown error';console.error('[race-day]',message);const expected=/Invalid|expired|must|large|limit|not ready|not found|already|processing|Unsupported|Caption|Car tag|Choose|Use a JSON/.test(message);return response({error:expected?message:'Uploads are temporarily unavailable. Please try again shortly.'},expected?400:503);}}
export const GET=handle;
export const POST=handle;
