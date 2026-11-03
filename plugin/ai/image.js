const schema = {
    type:'object',additionalProperties:false,required:['accepted','caption'],
    properties:{accepted:{type:'boolean'},caption:{type:'string'}},
};

function request(result, article, prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Image prompt is empty');
    return {
        system:prompt,
        input:JSON.stringify({title:article.title,text:result.paragraphs,suggestedCaption:result.image.caption}),
        schema,
    };
}

function apply(result, response) {
    let check;
    try {check = JSON.parse(response.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));} catch {check = null;}
    if (result.image && check?.accepted === true && typeof check.caption === 'string' && check.caption.trim()
        && Object.keys(check).length === 2) {
        result.image = {...result.image,caption:check.caption.trim(),verified:true};
    } else result.image = null;
    return result;
}

module.exports = {request,apply,schema};
