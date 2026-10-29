import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

const enabled=process.env.PWSH_BINARY&&process.env.MEDIAMTX_BINARY;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('Windows agent portable core with two real RTSP sources and owned-process recovery',{
 skip:enabled?false:'Set PWSH_BINARY and MEDIAMTX_BINARY for the isolated media laboratory',timeout:120000
},async()=>{
 const root=await mkdtemp(tmpdir()+'/nv-agent-media-');const children=[];
 const start=(binary,args,options={})=>{
  const child=spawn(binary,args,{stdio:['ignore','ignore','pipe'],...options});
  child.stderr?.resume();children.push(child);return child;
 };
 const waitForPort=async port=>{
  for(let i=0;i<60;i++){
   const ready=await new Promise(resolve=>{
    const socket=net.connect(port,'127.0.0.1');socket.on('connect',()=>{socket.destroy();resolve(true)});socket.on('error',()=>resolve(false));
   });if(ready)return;await sleep(100);
  }throw new Error('Local MediaMTX did not start');
 };
 try{
  // The agent's existing relay is deliberately fixed at localhost:8554. Never
  // stop a user's relay or silently use it: fail if this port is already taken.
  const probe=net.createServer();probe.listen(8554,'127.0.0.1');await once(probe,'listening');await new Promise(r=>probe.close(r));
  const config=root+'/mediamtx.yml';await writeFile(config,`logLevel: error
rtspAddress: 127.0.0.1:8554
rtspTransports: [udp, tcp]
rtpAddress: 127.0.0.1:8000
rtcpAddress: 127.0.0.1:8001
rtmp: false
hls: false
webrtc: false
srt: false
moq: false
authMethod: internal
authInternalUsers:
  - user: any
    ips: [127.0.0.1]
    permissions:
      - action: publish
        path: "~^(source_[ab]|camera_[a-f0-9-]{36})$"
  - user: reader
    pass: synthetic-secret
    permissions:
      - action: read
        path: "~^(source_[ab]|camera_[a-f0-9-]{36})$"
paths:
  "~^(source_[ab]|camera_[a-f0-9-]{36})$":
    source: publisher
`,{mode:0o600});
  start(resolve(process.env.MEDIAMTX_BINARY),[config]);await waitForPort(8554);
  for(const [name,color]of [['a','red'],['b','blue']])start('ffmpeg',['-v','error','-re','-f','lavfi','-i',`color=${color}:size=320x180:rate=15`,'-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-g','15','-f','rtsp','-rtsp_transport','tcp',`rtsp://127.0.0.1:8554/source_${name}`]);
  await sleep(1500);
  const child=start(resolve(process.env.PWSH_BINARY),['-NoLogo','-NoProfile','-File',resolve('connect/windows/tests/core.tests.ps1'),'-Media'],{
   stdio:['ignore','pipe','pipe'],env:{...process.env,
    XDG_CACHE_HOME:root+'/cache',XDG_CONFIG_HOME:root+'/config',XDG_DATA_HOME:root+'/data',
    NV_TEST_SOURCE_A:'rtsp://reader:synthetic-secret@127.0.0.1:8554/source_a',
    NV_TEST_SOURCE_B:'rtsp://reader:synthetic-secret@127.0.0.1:8554/source_b',NV_TEST_DIRECTORY:root}
  });
  let output='';child.stdout.on('data',part=>{output+=part});child.stderr.on('data',part=>{output+=part});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),90000);
  const [code]=await once(child,'exit');clearTimeout(timeout);
  assert.equal(code,0,output.replaceAll('synthetic-secret','[redacted]'));
  assert.match(output,/(15|17) checks passed/);
  const paths=JSON.parse(await readFile(root+'/paths.json','utf8'));
  const recordings=await readdir(root+'/recorded videos');assert.equal(recordings.length,4,'TS and MP4 preserved for both cameras');
  for(const [key,channel]of [['a',0],['b',2]]){
   const filename=root+'/recorded videos/'+paths[key].slice('camera_'.length)+'.mp4';
   const probe=spawnSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,width,height','-of','json',filename]);
   assert.equal(probe.status,0);const stream=JSON.parse(probe.stdout).streams[0];
   assert.deepEqual([stream.codec_name,stream.width,stream.height],['h264',1280,720]);
   const frame=spawnSync('ffmpeg',['-v','error','-i',filename,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
   assert.equal(frame.status,0);assert.ok(frame.stdout[channel]>200,`Camera ${key} must retain its own source color`);
   assert.ok(frame.stdout[channel===0?2:0]<30,'Other camera image must not leak into this recording');
  }
 }finally{
  for(const child of children.reverse()){
   if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  }
  await rm(root,{recursive:true,force:true});
 }
});
