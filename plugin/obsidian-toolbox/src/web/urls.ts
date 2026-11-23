function isPdf(value: string, contentType = '', disposition = '') {
    if (/^application\/(?:x-)?pdf(?:\s*;|\s*$)/i.test(contentType.trim())) return true;
    try {disposition = decodeURIComponent(disposition);} catch { /* Keep the original filename. */ }
    if (/filename\*?\s*=\s*(?:utf-8''|")?[^;]*\.pdf(?:"|;|$)/i.test(disposition.trim())) return true;
    try {
        const url = new URL(value);
        let path = url.pathname;
        try {path = decodeURIComponent(path);} catch { /* Keep the original path. */ }
        return /\.pdf$/i.test(path) || ((url.hostname==='arxiv.org' || url.hostname.endsWith('.arxiv.org')) && path.startsWith('/pdf/'))
            || [...url.searchParams].some(([key,value])=>
            /^(?:format|output)$/i.test(key) && /^pdf$/i.test(value)
            || /^(?:file|filename|document|attachment)$/i.test(key) && /\.pdf$/i.test(value));
    } catch {return false;}
}


export {isPdf};
