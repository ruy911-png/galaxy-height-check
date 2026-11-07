// @vitest-environment jsdom
// Synthetic WebXR contract checks, not room identification or phone accuracy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArDiagnostic } from '../src/arDiagnostic';

const threeState = vi.hoisted(() => ({ renderers: [] as Array<{ callback: ((time:number, frame?:XRFrame)=>void)|null; reference:EventTarget; loopBeforeSession:boolean }> }));
vi.mock('three', () => {
  class WebGLRenderer {
    callback: ((time:number, frame?:XRFrame)=>void)|null = null;
    reference = new EventTarget(); loopBeforeSession = false;
    domElement = document.createElement('canvas');
    xr = { enabled:false, setReferenceSpaceType:vi.fn(), setSession:vi.fn(async()=>{this.loopBeforeSession=this.callback!==null;}), getReferenceSpace:()=>this.reference };
    constructor(){threeState.renderers.push(this);}
    setPixelRatio(){} setSize(){} setClearColor(){} setAnimationLoop(callback:typeof this.callback){this.callback=callback;} render(){} dispose(){}
  }
  class RingGeometry {rotateX(){return this;} dispose(){}}
  class MeshBasicMaterial {dispose(){}}
  class Mesh {visible=false;matrixAutoUpdate=true;matrix={fromArray:vi.fn()};constructor(public geometry:RingGeometry,public material:MeshBasicMaterial){}}
  class Scene {add(){}clear(){}} class PerspectiveCamera {}
  return {WebGLRenderer,RingGeometry,MeshBasicMaterial,Mesh,Scene,PerspectiveCamera,DoubleSide:2};
});
const identity = () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const projection = (scale=2) => new Float32Array([scale,0,0,0,0,scale,0,0,0,0,-1.002,-1,0,0,-.2002,0]);
const diagnostics:ArDiagnostic[]=[];
type Source = XRHitTestSource & { side:'floor'|'ceiling';cancel:ReturnType<typeof vi.fn> };
type Hit = { y?:number; normal?:[number,number,number]; noPose?:boolean;emulated?:boolean };
type FrameOptions = { floor?:Hit[];ceiling?:Hit[];noViewer?:boolean;emulated?:boolean;scale?:number;stereo?:boolean;badProjection?:boolean };
function pose(hit:Hit){if(hit.noPose)return null;const m=identity();m[4]=hit.normal?.[0]??0;m[5]=hit.normal?.[1]??1;m[6]=hit.normal?.[2]??0;return {emulatedPosition:!!hit.emulated,transform:{position:{x:0,y:hit.y??0,z:-2},matrix:m}};}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
async function setup({deferred=false}={}){
  let now=1000;
  vi.spyOn(performance,'now').mockImplementation(()=>now);
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('XRRay',class {constructor(public origin:DOMPointInit,public direction:DOMPointInit){}});
  const sources:Source[]=[];
  const pending:Array<()=>void>=[];
  const rejectPending:Array<(error:Error)=>void>=[];
  const viewer=new EventTarget();
  const session=Object.assign(new EventTarget(),{
    visibilityState:'visible' as XRVisibilityState,
    requestReferenceSpace:vi.fn(async()=>viewer),
    requestHitTestSource:vi.fn((options:XRHitTestOptionsInit)=>{
      const ray=options.offsetRay!;
      const source={side:ray.direction.y>0?'ceiling':'floor',cancel:vi.fn()} as Source;
      sources.push(source);
      return deferred?new Promise<XRHitTestSource>((resolve,reject)=>{pending.push(()=>resolve(source));rejectPending.push(reject);}):Promise.resolve(source);
    }),
    end:vi.fn(async()=>session.dispatchEvent(new Event('end'))),
  });
  Object.defineProperty(navigator,'xr',{configurable:true,value:{requestSession:vi.fn(async()=>session)}});
  const onUpdate=vi.fn();
  const diagnostic=new ArDiagnostic({host:document.createElement('div'),overlay:document.createElement('div'),measurementMode:'single-view',onUpdate});
  diagnostics.push(diagnostic);await diagnostic.start();
  function frame(options:FrameOptions={}){
    const transform={position:{x:0,y:1.6,z:0},matrix:identity(),inverse:{matrix:identity()}};
    const p=options.badProjection?new Float32Array(16):projection(options.scale);
    const view={eye:'none',projectionMatrix:p,transform};
    const viewerPose=options.noViewer?null:{emulatedPosition:!!options.emulated,transform,views:options.stereo?[view,view]:[view]};
    const f={getViewerPose:vi.fn(()=>viewerPose),getHitTestResults:vi.fn((source:Source)=>
      (source.side==='floor'?(options.floor??[{y:0}]):(options.ceiling??[{y:2.5,normal:[0,-1,0]}])).map(hit=>({getPose:vi.fn(()=>pose(hit))}))) } as unknown as XRFrame;
    threeState.renderers.at(-1)!.callback!(now,f);return f;
  }
  return {diagnostic,session,sources,pending,rejectPending,onUpdate,frame,setNow:(value:number)=>{now=value;},async ready(){frame();await flush();now+=16;frame();},windowFrame(){threeState.renderers.at(-1)!.callback!(now);}};
}
afterEach(async()=>{for(const d of diagnostics.splice(0))await d.stop();threeState.renderers.length=0;vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(navigator,'xr');});

describe('simultaneous single-view real hit pairs',()=>{
  it('waits for a genuine mono view and creates exactly two offset plane sources',async()=>{
    const s=await setup();expect(s.session.requestHitTestSource).not.toHaveBeenCalled();
    expect(threeState.renderers.at(-1)!.loopBeforeSession).toBe(true);
    s.windowFrame();expect(s.session.requestHitTestSource).not.toHaveBeenCalled();
    await s.ready();expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(2);
    const opts=s.session.requestHitTestSource.mock.calls.map(c=>c[0]);
    expect(opts.every(o=>o.entityTypes?.[0]==='plane')).toBe(true);
    expect(opts.map(o=>Math.sign(o.offsetRay!.direction.y)).sort()).toEqual([-1,1]);
    const pair=s.diagnostic.getCurrentPair();expect(pair.floor?.position.y).toBe(0);expect(pair.ceiling?.position.y).toBe(2.5);
    expect(pair.floor?.timestamp).toBe(pair.ceiling?.timestamp);expect(pair.floor?.sessionId).toBe(pair.ceiling?.sessionId);expect(pair.floor?.epoch).toBe(pair.ceiling?.epoch);
  });
  it('never reuses a missing ceiling or floor from the previous frame',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({ceiling:[]});
    expect(s.diagnostic.getCurrentPair().ceiling).toBeNull();expect(s.diagnostic.getCurrentPair().floor?.timestamp).toBe(1032);
    s.setNow(1048);s.frame({floor:[]});expect(s.diagnostic.getCurrentPair().floor).toBeNull();expect(s.diagnostic.getCurrentPair().ceiling?.timestamp).toBe(1048);
  });
  it.each([{noPose:true},{emulated:true},{normal:[0,NaN,0] as [number,number,number]}])('does not skip an invalid nearest hit (%j) to a farther ceiling',async bad=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({ceiling:[bad,{y:2.5}]});expect(s.diagnostic.getCurrentPair().ceiling).toBeNull();
  });
  it('retains the nearest wall candidate for the model to reject, not a farther horizontal plane',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({ceiling:[{y:1.9,normal:[0,0,1]},{y:2.5}]});expect(s.diagnostic.getCurrentPair().ceiling).toMatchObject({normalY:0,position:{y:1.9}});
  });
  it('clears both hits immediately on pose loss and separates the recovered epoch',async()=>{
    const s=await setup();await s.ready();const epoch=s.diagnostic.getCurrentPair().floor!.epoch;s.setNow(1032);s.frame({noViewer:true});expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});s.setNow(1048);s.frame();expect(s.diagnostic.getCurrentPair().floor!.epoch).toBeGreaterThan(epoch);
  });
  it('freshness getter clears old hits and ordinary window frames cannot hide real frame gaps',async()=>{
    const s=await setup();await s.ready();const epoch=s.diagnostic.getCurrentPair().floor!.epoch;s.setNow(1300);s.windowFrame();expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});s.frame();expect(s.diagnostic.getCurrentPair().floor!.epoch).toBeGreaterThan(epoch);
  });
  it('does not recursively notify when a subscriber reads the stale pair',async()=>{
    const s=await setup();await s.ready();s.onUpdate.mockClear();s.onUpdate.mockImplementation(()=>s.diagnostic.getCurrentPair());s.setNow(1300);
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});expect(s.onUpdate).toHaveBeenCalledTimes(1);
  });
  it('visibility change and reference reset clear both hits',async()=>{
    const s=await setup();await s.ready();s.session.visibilityState='hidden';s.session.dispatchEvent(new Event('visibilitychange'));expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});s.session.visibilityState='visible';s.session.dispatchEvent(new Event('visibilitychange'));s.frame();expect(s.diagnostic.getCurrentPair().floor).not.toBeNull();threeState.renderers.at(-1)!.reference.dispatchEvent(new Event('reset'));expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
  });
  it('recreates changed projection rays and offers no pair until the new sources are ready',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({scale:3});expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});expect(s.sources.slice(0,2).every(x=>x.cancel.mock.calls.length===1)).toBe(true);await flush();s.setNow(1048);s.frame({scale:3});expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(4);expect(s.diagnostic.getCurrentPair().floor).not.toBeNull();
  });
  it('announces a changed camera view and invalidates the previous pair while zoom rays are recreated',async()=>{
    const s=await setup();await s.ready();const before=s.session.requestHitTestSource.mock.calls[1][0].offsetRay!.direction.y;
    s.setNow(1032);s.frame({scale:4});
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
    expect(s.onUpdate.mock.calls.at(-1)?.[0]).toMatchObject({phase:'searching',canConfirm:false,message:'카메라 시야가 바뀌어 두 위치를 다시 읽고 있어요.'});
    await flush();s.setNow(1048);s.frame({scale:4});
    expect(s.diagnostic.getCurrentPair().ceiling?.timestamp).toBe(1048);
    expect(s.session.requestHitTestSource.mock.calls[3][0].offsetRay!.direction.y).toBeLessThan(before);
  });
  it('rapid zoom in then out cancels late obsolete sources and reads only the latest field of view',async()=>{
    const s=await setup({deferred:true});s.frame();s.pending[0]();s.pending[1]();await flush();s.setNow(1016);s.frame();
    expect(s.diagnostic.getCurrentPair().floor).not.toBeNull();
    s.setNow(1032);s.frame({scale:4});s.setNow(1048);s.frame({scale:1});
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
    s.pending[2]();s.pending[3]();await flush();
    expect(s.sources.slice(0,4).every(x=>x.cancel.mock.calls.length===1)).toBe(true);
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
    s.pending[4]();s.pending[5]();await flush();s.setNow(1064);s.frame({scale:1});
    expect(s.diagnostic.getCurrentPair().ceiling?.timestamp).toBe(1064);expect(s.sources.slice(4).every(x=>x.cancel.mock.calls.length===0)).toBe(true);
  });
  it('a rejected obsolete zoom request cannot end the current latest configuration',async()=>{
    const s=await setup({deferred:true});s.frame();s.setNow(1016);s.frame({scale:3});
    s.rejectPending[0](new Error('old source rejected'));s.pending[1]();await flush();expect(s.session.end).not.toHaveBeenCalled();
    s.pending[2]();s.pending[3]();await flush();s.setNow(1032);s.frame({scale:3});expect(s.diagnostic.getCurrentPair().floor).not.toBeNull();
  });
  it('blocks browser pinch zoom even when the XR projection is unchanged, then reacquires at normal screen scale',async()=>{
    const s=await setup();await s.ready();
    vi.stubGlobal('visualViewport',{scale:2,offsetLeft:0,offsetTop:0});
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null}); // A zoom between XR frames is blocked too.
    s.setNow(1032);s.frame();
    expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
    expect(s.onUpdate.mock.calls.at(-1)?.[0]).toMatchObject({phase:'searching',canConfirm:false,message:'화면 확대를 원래 크기로 돌려 주세요. 표시와 카메라 위치가 맞지 않아 측정을 멈췄어요.'});
    expect(s.sources.every(source=>source.cancel.mock.calls.length===1)).toBe(true);
    vi.stubGlobal('visualViewport',{scale:1,offsetLeft:0,offsetTop:0});s.setNow(1048);s.frame();expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
    await flush();s.setNow(1064);s.frame();expect(s.diagnostic.getCurrentPair().floor?.timestamp).toBe(1064);
  });
  it.each([{scale:NaN,offsetLeft:0,offsetTop:0},{scale:1,offsetLeft:80,offsetTop:0}])('blocks an invalid or panned browser viewport (%j)',async viewport=>{
    const s=await setup();await s.ready();vi.stubGlobal('visualViewport',viewport);s.setNow(1032);s.frame();expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
  });
  it('tiny projection jitter does not continuously recreate otherwise equivalent sources',async()=>{
    const s=await setup();await s.ready();for(let i=1;i<=10;i++){s.setNow(1016+i*16);s.frame({scale:2+(i%2)*1e-6});}
    expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(2);expect(s.diagnostic.getCurrentPair().floor).not.toBeNull();
  });
  it.each([{stereo:true},{badProjection:true}])('blocks an unsupported or invalid view (%j)',async options=>{
    const s=await setup();s.frame(options);await flush();expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});expect(s.session.requestHitTestSource).not.toHaveBeenCalled();
  });
  it('cancels pending sources that arrive after stop',async()=>{
    const s=await setup({deferred:true});s.frame();expect(s.pending).toHaveLength(2);await s.diagnostic.stop();for(const resolve of s.pending)resolve();await flush();expect(s.sources.every(x=>x.cancel.mock.calls.length===1)).toBe(true);expect(s.diagnostic.getCurrentPair()).toEqual({floor:null,ceiling:null});
  });
  it('publishes every real pair even inside 100ms so an intermediate tilted sample is never skipped',async()=>{
    const s=await setup();await s.ready();s.onUpdate.mockClear();
    s.setNow(1032);s.frame();s.setNow(1048);s.frame({ceiling:[{y:2.5,normal:[0,0,1]}]});s.setNow(1064);s.frame();
    expect(s.onUpdate).toHaveBeenCalledTimes(3);
    expect(s.onUpdate.mock.calls.every(c=>c[0].phase==='surface')).toBe(true);
  });
  it('returns detached hit copies',async()=>{
    const s=await setup();await s.ready();const pair=s.diagnostic.getCurrentPair();pair.floor!.position.y=999;expect(s.diagnostic.getCurrentPair().floor?.position.y).toBe(0);
  });
});
