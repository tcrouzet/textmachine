import {domainToASCII} from 'node:url';
import {isIP} from 'node:net';
import suffixes from '../scripts/vendor/public_suffix_list.dat';
const rules = new Set(suffixes
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'))
    .map(rule => (rule.startsWith('!') ? '!' : '') + domainToASCII(rule.replace(/^!/, ''))));

function domainOf(value: string) {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid domain');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host.replace(/^\[|\]$/g, ''))) return host;
    const starts = [0, ...Array.from(host.matchAll(/\./g), match => match.index + 1)];
    let suffix = 1;
    for (const [index, start] of starts.entries()) {
        const candidate = host.slice(start);
        if (rules.has('!' + candidate)) { suffix = starts.length - index - 1; break; }
        if (rules.has(candidate)) suffix = Math.max(suffix, starts.length - index);
        if (index > 0 && rules.has('*.' + candidate)) suffix = Math.max(suffix, starts.length - index + 1);
    }
    return host.slice(starts[Math.max(0,starts.length-suffix-1)]);
}

export {domainOf};
