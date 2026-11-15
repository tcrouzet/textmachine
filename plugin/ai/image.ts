import {t} from '../i18n';
import {requestWithSignal} from './generate';
import {Connection, Progress, StreamRequest, array, record} from '../types';

async function generate(connection: Connection, prompt: string, request: StreamRequest, signal?: AbortSignal, progress?: Progress): Promise<ArrayBuffer> {
    if (connection.provider!=='openai' || connection.baseUrl) throw new Error(t('newsletterImageUnsupported',{model:connection.model}));
    if (!connection.apiKey) throw new Error(t('aiMissingKey',{provider:'OpenAI'}));
    if (!prompt.trim()) throw new Error(t('newsletterImagePromptEmpty'));
    progress?.('',false,false,'OpenAI · '+connection.model);
    const options={url:'https://api.openai.com/v1/responses',method:'POST',contentType:'application/json',throw:false,
        headers:{Authorization:'Bearer '+connection.apiKey},
        body:JSON.stringify({model:connection.model,input:prompt,tools:[{type:'image_generation',output_format:'png'}],tool_choice:{type:'image_generation'},store:false})};
    const response=await requestWithSignal(options,options=>request(options,undefined,signal,32*1024*1024),signal);
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    if (response.status<200 || response.status>=300) throw new Error(t('newsletterIllustrationApiFailed',{status:response.status}));
    const result=record(response.json);
    if (result.status==='incomplete' || result.status==='failed') throw new Error(t('newsletterIllustrationFailed'));
    const item=array(result.output).map(record).find(item=>item.type==='image_generation_call' && item.status==='completed');
    return decodeImage(item?.result);
}

function decodeImage(value: unknown): ArrayBuffer {
    const encoded=typeof value==='string' ? value.replace(/^data:image\/png;base64,/,'') : value;
    if (typeof encoded!=='string' || encoded.length>32*1024*1024 || encoded.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(t('newsletterIllustrationFailed'));
    const bytes=Buffer.from(encoded,'base64');
    if (bytes.length<33 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || bytes.subarray(12,16).toString()!=='IHDR'
        || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16)>4096 || bytes.readUInt32BE(20)>4096) throw new Error(t('newsletterIllustrationFailed'));
    return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}

export {generate,decodeImage};
