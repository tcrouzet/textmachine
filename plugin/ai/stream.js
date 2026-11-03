const http = require('node:http');
const https = require('node:https');
const {t} = require('../i18n');

function requestStream(options, onChunk, signal) {
    return new Promise((resolve,reject) => {
        const url = new URL(options.url);
        const request = (url.protocol === 'https:' ? https : http).request(url,{
            method:options.method,signal,headers:{'Content-Type':options.contentType,...options.headers},
        },response => {
            const status = response.statusCode;
            const streaming = response.headers['content-type']?.toLowerCase().includes('text/event-stream');
            let body = '';
            response.setEncoding('utf8');
            response.on('data',chunk => {
                if (signal?.aborted || status < 200 || status >= 300) return;
                try {
                    if (streaming) onChunk(chunk);
                    else {
                        body += chunk;
                        if (body.length > 4 * 1024 * 1024) throw new Error(t('newsletterInvalid'));
                    }
                } catch (error) {request.destroy(error);}
            });
            response.on('error',reject);
            response.on('end',() => {
                try {resolve(streaming || status < 200 || status >= 300 ? {status} : {status,json:JSON.parse(body)});}
                catch {reject(new Error(t('newsletterInvalid')));}
            });
        });
        request.on('error',reject);
        request.end(options.body);
    });
}

function parseStream(connection, progress) {
    let buffer = '', text = '', complete = false, failed = false, response, stopReason;
    const emit = delta => {
        if (typeof delta !== 'string' || !delta) return;
        text += delta;
        progress?.(delta,true);
    };
    const push = chunk => {
        buffer += chunk;
        if (buffer.length > 4 * 1024 * 1024) throw new Error(t('newsletterInvalid'));
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0,boundary.index);
            buffer = buffer.slice(boundary.index+boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            if (data === '[DONE]') {if (connection.baseUrl) complete = true;continue;}
            let event;
            try {event = JSON.parse(data);} catch {throw new Error(t('newsletterInvalid'));}
            if (event.error || ['error','response.failed','response.incomplete'].includes(event.type)) failed = true;
            if (connection.provider === 'anthropic') {
                if (event.type === 'content_block_start') emit(event.content_block?.text);
                if (event.type === 'content_block_delta') emit(event.delta?.text);
                if (event.type === 'message_delta') stopReason = event.delta?.stop_reason;
                if (event.type === 'message_stop') complete = true;
            } else if (connection.baseUrl) {
                emit(event.choices?.[0]?.delta?.content);
                if (event.choices?.[0]?.finish_reason) {stopReason = event.choices[0].finish_reason;complete = true;}
            } else {
                if (event.type === 'response.output_text.delta') emit(event.delta);
                if (event.type === 'response.completed') {
                    response = event.response;
                    complete = response?.status === 'completed';
                }
            }
        }
    };
    return {push,finish:() => {
        push('\n\n');
        if (!complete || failed) throw new Error(t('newsletterIncomplete'));
        if (connection.provider === 'anthropic') return {content:[{type:'text',text}],stop_reason:stopReason};
        if (connection.baseUrl) return {choices:[{message:{content:text},finish_reason:stopReason}]};
        return response || {output:[{type:'message',content:[{type:'output_text',text}]}]};
    }};
}

module.exports = {requestStream,parseStream};
