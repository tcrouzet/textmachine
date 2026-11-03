const {domainToASCII} = require('node:url');
const {isIP} = require('node:net');
const rules = new Set(require('../scripts/vendor/public_suffix_list.dat')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'))
    .map(rule => (rule.startsWith('!') ? '!' : '') + domainToASCII(rule.replace(/^!/, ''))));

function domainOf(value) {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid domain');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(host.replace(/^\[|\]$/g, ''))) return host;
    const labels = host.split('.');
    let suffix = 1;
    for (let index = 0; index < labels.length; index++) {
        const candidate = labels.slice(index).join('.');
        if (rules.has('!' + candidate)) { suffix = labels.length - index - 1; break; }
        if (rules.has(candidate)) suffix = Math.max(suffix, labels.length - index);
        if (index > 0 && rules.has('*.' + candidate)) suffix = Math.max(suffix, labels.length - index + 1);
    }
    return labels.slice(-suffix - 1).join('.');
}

module.exports = {domainOf};
