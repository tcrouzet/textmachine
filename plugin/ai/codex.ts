import {t} from '../i18n';
import {version} from '../../manifest.json';
import {createCodexGeneration} from '../obsidian-toolbox/src/ai/codex-generation';
import {decodeImage} from './image';
const runtime=createCodexGeneration(t,{name:'text-machine',title:'Text Machine',version});
export const {findCodex,listModels,generate}=runtime;
export const generateImage: (...args: Parameters<typeof runtime.generateImage>) => Promise<ReturnType<typeof decodeImage>> = async (...args)=>decodeImage(await runtime.generateImage(...args));
