import {t} from './i18n';

export async function createIllustration(data: ArrayBuffer): Promise<{data: ArrayBuffer}> {
    const url=URL.createObjectURL(new Blob([data],{type:'image/png'}));
    try {
        const image=new Image();
        image.src=url;
        await image.decode();
        const canvas=document.createElement('canvas');
        canvas.width=1600;
        canvas.height=1200;
        const context=canvas.getContext('2d');
        if (!context) throw new Error(t('newsletterIllustrationFailed'));
        context.fillStyle='#fff';
        context.fillRect(0,0,canvas.width,canvas.height);
        context.filter='grayscale(1)';
        context.drawImage(image,0,0,canvas.width,canvas.height);
        const blob=await new Promise<Blob | null>(resolve=>canvas.toBlob(resolve,'image/png'));
        if (!blob) throw new Error(t('newsletterIllustrationFailed'));
        return {data:await blob.arrayBuffer()};
    } catch {
        throw new Error(t('newsletterIllustrationFailed'));
    } finally {URL.revokeObjectURL(url);}
}
