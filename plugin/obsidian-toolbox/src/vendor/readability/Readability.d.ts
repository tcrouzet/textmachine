export default class Readability {
    constructor(document: Document);
    parse(): {textContent: string; content: string; publishedTime?: string | null; byline?: string | null} | null;
}
