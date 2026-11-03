export function parseHTML(html: string): Document {
    return new DOMParser().parseFromString(html,'text/html');
}
