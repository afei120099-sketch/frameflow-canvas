import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseShotQueue,planShotReferences,shotQueueH3Props} from '../lib/shot-queue.ts';
import {queueFramePlan} from '../lib/shot-queue-frames.ts';

const cases=[
  {path:'docs/队列JSON模板-主镜头与独立续段.json',main:2,dependent:3,order:['镜头A','镜头B','镜头A-续段1','镜头A到B-过渡','镜头A-续段2']},
  {path:'docs/队列JSON模板-独立续段带角色对白.json',main:1,dependent:1,order:['对白A','对白A-续段']},
];
for(const test of cases){
  const source=readFileSync(test.path,'utf8');
  for(const autoVoice of [true,false]){
    const queue=parseShotQueue(source,autoVoice),plan=queueFramePlan(queue);
    assert.equal(plan.main.length,test.main);assert.equal(plan.dynamic.length,test.dependent);
    const get=key=>{const[c,s]=key.split(':').map(Number);return queue.chapters[c].shots[s];};
    assert.deepEqual(plan.order.map(key=>get(key).title),test.order);
    for(const key of plan.order){
      const shot=get(key);
      assert.throws(()=>planShotReferences(shot,[],new Map()),/角色不存在/,'format examples cannot run against absent placeholder roles');
      const roles=shot.roleIds.map(roleId=>({roleId,displayName:'测试替身',primaryAppearanceAssetId:'fixture-face'}));
      const assets=new Map([['fixture-face',{assetId:'fixture-face',kind:'image',filename:'face.png',storageReference:'image:fixture-face'}],...shot.sceneAssetIds.map(id=>[id,{assetId:id,kind:'image',filename:'scene.png',storageReference:'image:fixture-scene'}])]);
      const props=shotQueueH3Props(shot,planShotReferences(shot,roles,assets),queue.defaults);
      assert.equal(props.prompt,shot.prompt);assert.deepEqual(props.roleIds,shot.roleIds);assert.equal(props.duration,String(shot.seconds));
      assert.equal(props.ultimateKeyframes,Boolean(shot.firstFrameFrom||shot.lastFrameFrom));
      if(shot.dialogue){assert.deepEqual(props.dialogueLines,shot.dialogue);assert.equal(props.soundMode,'av');assert.equal(props.autoVoiceDisabled,undefined);assert.ok(shot.prompt.includes(shot.dialogue[0].text));}
    }
  }
  console.log(`PASS ${test.path}: parser, stage order, independent props/dialogue and placeholder guard`);
}
const guide=readFileSync('docs/队列JSON写法说明-独立续拍与首尾帧过渡-20261019.txt','utf8');
for(const key of ['firstFrameFrom','lastFrameFrom','generationMode','roleIds','sceneAssetIds','dialogue','autoVoiceDisabled','previous','5～15'])assert.ok(guide.includes(key));
console.log('PASS queue JSON documentation/examples; no network, data writes, queue imports or GPU jobs');
