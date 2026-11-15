import {t} from '../i18n';
import {parseStream,requestStream} from './stream';
import {Connection, HttpOptions, HttpResponse, Progress, StreamRequest, array, record} from '../types';

async function generate(connection: Connection, system: string, input: string, request: StreamRequest, signal?: AbortSignal, progress?: Progress, imageUrl?: string) {
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    const anthropic = connection.provider === 'anthropic';
    const local = !!connection.baseUrl;
    const provider = anthropic ? 'Anthropic' : local ? t('aiLocalServer') : 'OpenAI';
    const userContent = imageUrl ? (anthropic
        ? [{type:'image',source:{type:'url',url:imageUrl}},{type:'text',text:input}]
        : [{type:'text',text:input},{type:'image_url',image_url:{url:imageUrl,detail:'high'}}]) : input;
    const responseInput = imageUrl ? [{role:'user',content:[{type:'input_text',text:input},{type:'input_image',image_url:imageUrl,detail:'high'}]}] : input;
    const options: HttpOptions = {
        url:anthropic ? 'https://api.anthropic.com/v1/messages' : local ? connection.baseUrl + '/chat/completions' : 'https://api.openai.com/v1/responses',
        method:'POST', contentType:'application/json', throw:false,
        headers:anthropic ? {'x-api-key':connection.apiKey,'anthropic-version':'2023-06-01'} : local ? {} : {Authorization:'Bearer '+connection.apiKey},
        body:JSON.stringify(anthropic ? {model:connection.model, stream:true, max_tokens:8192, system, messages:[{role:'user',content:userContent}]}
            : local ? {model:connection.model,max_tokens:8192,stream:true,messages:[{role:'system',content:system},{role:'user',content:userContent}]}
                : {model:connection.model,instructions:system,input:responseInput,stream:true,max_output_tokens:8192,store:false}),
    };
    const stream = parseStream(connection,progress);
    const response = await requestWithSignal(options,options=>request(options,stream.push,signal),signal);
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    if (response.status < 200 || response.status >= 300) throw new Error(t('newsletterApiFailed',{provider,status:response.status}));
    let value: unknown;
    try {value = response.json;} catch {throw new Error(t('newsletterInvalid'));}
    const data = record(value === undefined ? stream.finish() : value);
    const choice = record(array(data.choices)[0]);
    if (data?.status === 'incomplete' || data?.status === 'failed' || data?.stop_reason === 'max_tokens'
        || choice.finish_reason === 'length') throw new Error(t('newsletterIncomplete'));
    const blocks = anthropic ? array(data.content) : array(data.output).map(record).filter(item=>item.type==='message').flatMap(item=>array(item.content));
    const text = local ? record(choice.message).content : blocks.map(record).filter(block=>block.type===(anthropic ? 'text' : 'output_text'))
        .map(block=>{if (typeof block.text!=='string') throw new Error(t('newsletterInvalid'));return block.text;}).join('');
    if (typeof text !== 'string' || !text.trim()) throw new Error(t('newsletterInvalid'));
    return text;
}

async function requestWithSignal<T extends HttpResponse>(options: HttpOptions, request: (options: HttpOptions)=>Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    let abort: (()=>void) | undefined;
    try {
        const interrupted = new Promise<never>((_,reject) => {
            abort = () => reject(new Error());
            signal?.addEventListener('abort',abort,{once:true});
        });
        return await Promise.race([request(options),interrupted]);
    } catch {
        throw new Error(signal?.aborted ? t('newsletterCancelled') : t('newsletterNetworkFailed'));
    } finally {
        if (abort) signal?.removeEventListener('abort',abort);
    }
}

export {generate, requestWithSignal,requestStream};
