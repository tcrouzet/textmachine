import {t} from '../i18n';
import {createStreamingGeneration} from '../obsidian-toolbox/src/ai/stream-generation';
export const {generate,requestWithSignal,requestStream}=createStreamingGeneration(t);
