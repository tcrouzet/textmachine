const {t} = require('../i18n');
const {parseStream,requestStream} = require('./stream');

async function generate(connection, system, input, request, signal, progress, imageUrl) {
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    const anthropic = connection.provider === 'anthropic';
    const local = !!connection.baseUrl;
    const provider = anthropic ? 'Anthropic' : local ? t('aiLocalServer') : 'OpenAI';
    const userContent = imageUrl ? (anthropic
        ? [{type:'image',source:{type:'url',url:imageUrl}},{type:'text',text:input}]
        : [{type:'text',text:input},{type:'image_url',image_url:{url:imageUrl,detail:'high'}}]) : input;
    const responseInput = imageUrl ? [{role:'user',content:[{type:'input_text',text:input},{type:'input_image',image_url:imageUrl,detail:'high'}]}] : input;
    const options = {
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
    let data;
    try {data = response.json;} catch {throw new Error(t('newsletterInvalid'));}
    if (data === undefined) data = stream.finish();
    if (data?.status === 'incomplete' || data?.status === 'failed' || data?.stop_reason === 'max_tokens'
        || data?.choices?.[0]?.finish_reason === 'length') throw new Error(t('newsletterIncomplete'));
    const text = anthropic ? data?.content?.filter(block => block.type === 'text').map(block => block.text).join('')
        : local ? data?.choices?.[0]?.message?.content
            : data?.output?.filter(item => item.type === 'message').flatMap(item => item.content || [])
                .filter(block => block.type === 'output_text').map(block => block.text).join('');
    if (typeof text !== 'string' || !text.trim()) throw new Error(t('newsletterInvalid'));
    return text;
}

async function requestWithSignal(options, request, signal) {
    if (signal?.aborted) throw new Error(t('newsletterCancelled'));
    let abort;
    try {
        const interrupted = new Promise((_,reject) => {
            abort = () => reject(new Error());
            signal?.addEventListener('abort',abort,{once:true});
        });
        return await Promise.race([request(options),interrupted]);
    } catch {
        throw new Error(signal?.aborted ? t('newsletterCancelled') : t('newsletterNetworkFailed'));
    } finally {
        signal?.removeEventListener('abort',abort);
    }
}

module.exports = {generate, requestWithSignal,requestStream};
