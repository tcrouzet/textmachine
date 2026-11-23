import {t} from '../i18n';
import {createStreamTransport} from '../obsidian-toolbox/src/ai/stream';
export const {requestStream,parseStream}=createStreamTransport(t);
