import {t} from '../i18n';
import {requestWithSignal} from './generate';
import {HttpOptions, HttpResponse, array, record} from '../types';

async function generate(apiKey: string, prompt: string, request: (options: HttpOptions, signal?: AbortSignal)=>Promise<HttpResponse>, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!apiKey) throw new Error(t('newsletterImageKeyMissing'));
    if (!prompt.trim()) throw new Error(t('newsletterImagePromptEmpty'));
    const options={url:'https://api.openai.com/v1/images/generations',method:'POST',contentType:'application/json',throw:false,
        headers:{Authorization:'Bearer '+apiKey},
        body:JSON.stringify({model:'gpt-image-2.5-flare',prompt,size:'1600x1200',quality:'high',output_format:'png',n:1})};
    const response=await requestWithSignal(options,options=>request(options,signal),signal);
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    if (response.status<200 || response.status>=300) throw new Error(t('newsletterIllustrationApiFailed',{status:response.status}));
    const encoded=record(array(record(response.json).data)[0]).b64_json;
    if (typeof encoded!=='string' || encoded.length>32*1024*1024 || encoded.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(t('newsletterIllustrationFailed'));
    const bytes=Buffer.from(encoded,'base64');
    if (bytes.length<33 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || bytes.subarray(12,16).toString()!=='IHDR'
        || bytes.readUInt32BE(16)!==1600 || bytes.readUInt32BE(20)!==1200) throw new Error(t('newsletterIllustrationFailed'));
    return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
}

export {generate};
