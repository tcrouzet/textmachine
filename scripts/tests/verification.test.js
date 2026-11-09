const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../../plugin/i18n').setLocale('en');
const {verificationRequest,parseVerification}=require('../../plugin/newsletter');

const original={title:'Two emails accuse a novelist',chapeau:'Two emails demand money from the novelist.',
    paragraphs:['Two emails accuse Anne R. Allen of using AI and demand payment to clean her writing.',
        'She describes the attempted blackmail on [her blog](https://example.com/scam).']};
const corrected={title:'Scammers accuse a novelist',chapeau:'Scammers demand money from a novelist by claiming to detect AI in her writing.',
    paragraphs:['Scammers claiming to run an AI detection service accuse Anne R. Allen of using AI and demand payment to clean her writing.',original.paragraphs[1]],issues:[]};

test('verification receives the complete editorial and source text without images or persistent state',()=>{
    const source={id:41,title:'Blackmail',url:'https://example.com/scam',source:'User',authors:['Anne R. Allen'],publish:'2026-11-01',
        content:'Scammers claimed to run an AI detection service.',status:'',usedAt:'2026-11-07',image:'https://private.test/photo',annotation:'private-note'};
    const request=verificationRequest('{"newsletter":{{newsletter}},"articles":{{articles}},"language":"{{language}}"}',
        {...original,image:{url:'illustrations/image.png'},used:['https://example.com/scam']},[source],'English');
    const input=JSON.parse(request.input);
    assert.deepEqual(input.newsletter,original);
    assert.equal(input.language,'English');
    assert.deepEqual(input.articles,[{id:41,title:source.title,url:source.url,source:source.source,authors:source.authors,publish:source.publish,content:source.content}]);
    assert.deepEqual(request.schema,require('../../models/verifier.json'));
    assert.deepEqual(JSON.parse(request.system.split('\n\n').at(-1)).jsonSchema,request.schema);
    for (const template of ['Only {{articles}}','Only {{newsletter}}','{{newsletter}} {{articles}} {{unknown}}',' '])
        assert.throws(()=>verificationRequest(template,original,[source],'English'),/prompt|variable/);
});

test('verification only approves or reports issues and cannot return edited text',()=>{
    assert.equal(parseVerification(JSON.stringify({issues:[]})),undefined);
    assert.throws(()=>parseVerification(JSON.stringify({issues:['The source does not identify the sender.']})),/blocked saving.*does not identify the sender/);
    assert.throws(()=>parseVerification(JSON.stringify(corrected)),/Invalid AI response/);
});

test('verification rejects malformed approvals and any attempted text or state changes',()=>{
    const invalid=[{},null,[],{issues:'approved'},{issues:[null]},{issues:[' ']},
        {issues:[],status:'used'},{issues:[],title:'Another title'},{issues:[],chapeau:'Another introduction'},
        {issues:[],paragraphs:[]},{issues:[],paragraphs:['Short.','Text.']},
        {issues:[],paragraphs:corrected.paragraphs.map(p=>p.replace('example.com','other.test'))},
        {issues:[],paragraphs:[...corrected.paragraphs,'![An image](https://example.com/photo)']}];
    for (const response of ['{broken',...invalid.map(value=>JSON.stringify(value))])
        assert.throws(()=>parseVerification(response),/Invalid AI response/);
});
