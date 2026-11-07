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
type Source = XRHitTestSource & { cancel:ReturnType<typeof vi.fn> };
type Hit = { y?:number; normal?:[number,number,number]; noPose?:boolean;emulated?:boolean };
type FrameOptions = { hits?:Hit[];noViewer?:boolean;emulated?:boolean;shift?:number;pitch?:number;stereo?:boolean;badProjection?:boolean };
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
      const source={cancel:vi.fn()} as Source;
      sources.push(source);
      return deferred?new Promise<XRHitTestSource>((resolve,reject)=>{pending.push(()=>resolve(source));rejectPending.push(reject);}):Promise.resolve(source);
    }),
    end:vi.fn(async()=>session.dispatchEvent(new Event('end'))),
  });
  Object.defineProperty(navigator,'xr',{configurable:true,value:{requestSession:vi.fn(async()=>session)}});
  const onUpdate=vi.fn();
  const diagnostic=new ArDiagnostic({host:document.createElement('div'),overlay:document.createElement('div'),measurementMode:'base-top',onUpdate});
  diagnostics.push(diagnostic);await diagnostic.start();
  function frame(options:FrameOptions={}){
    const m=identity(); const a=options.pitch??0; m[5]=Math.cos(a);m[6]=Math.sin(a);m[9]=-Math.sin(a);m[10]=Math.cos(a);m[13]=1.6;
    const transform={position:{x:0,y:1.6,z:0},matrix:m};
    const p=options.badProjection?new Float32Array(16):projection();p[8]=options.shift??0;
    const view={eye:'none',projectionMatrix:p,transform};
    const viewerPose=options.noViewer?null:{emulatedPosition:!!options.emulated,transform,views:options.stereo?[view,view]:[view]};
    const f={getViewerPose:vi.fn(()=>viewerPose),getHitTestResults:vi.fn((source:Source)=>
      (options.hits??[{y:0}]).map(hit=>({getPose:vi.fn(()=>pose(hit))}))) } as unknown as XRFrame;
    threeState.renderers.at(-1)!.callback!(now,f);return f;
  }
  return {diagnostic,session,sources,pending,rejectPending,onUpdate,frame,setNow:(value:number)=>{now=value;},async ready(){frame();await flush();now+=16;frame();},windowFrame(){threeState.renderers.at(-1)!.callback!(now);}};
}
afterEach(async()=>{for(const d of diagnostics.splice(0))await d.stop();threeState.renderers.length=0;vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(navigator,'xr');});

describe('base-to-top tracked center aim frames',()=>{
  it('waits for real view then requests one actual center ray and same-frame nearest hit',async()=>{
    const s=await setup();expect(s.session.requestHitTestSource).not.toHaveBeenCalled();
    expect(threeState.renderers.at(-1)!.loopBeforeSession).toBe(true);
    await s.ready();expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(1);
    const frame=s.diagnostic.getCurrentAimFrame();expect(frame).toMatchObject({source:'webxr-view-ray',hitState:'valid',origin:{x:0,z:0},direction:{x:0,y:0,z:-1}});expect(frame!.origin.y).toBeCloseTo(1.6);
    expect(frame?.hit?.timestamp).toBe(frame?.timestamp);expect(frame?.hit?.sessionId).toBe(frame?.sessionId);expect(frame?.hit?.epoch).toBe(frame?.epoch);
  });
  it('keeps a fresh tracked ray with no surface but removes the earlier hit',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({hits:[]});
    expect(s.diagnostic.getCurrentAimFrame()).toMatchObject({timestamp:1032,hitState:'none',hit:null});
    expect(s.onUpdate.mock.calls.at(-1)?.[0].phase).toBe('searching');
  });
  it('uses the tracked camera pitch in world coordinates while its center source stays viewer-relative',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({pitch:Math.PI/4,hits:[]});
    const f=s.diagnostic.getCurrentAimFrame()!;expect(f.direction.y).toBeCloseTo(Math.SQRT1_2);expect(f.direction.z).toBeCloseTo(-Math.SQRT1_2);
    expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(1);
  });
  it.each([{noPose:true},{emulated:true},{normal:[0,NaN,0] as [number,number,number]}])('labels an invalid nearest surface distinctly from no hit (%j)',async bad=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({hits:[bad,{y:2.4}]});
    expect(s.diagnostic.getCurrentAimFrame()).toMatchObject({hitState:'invalid',hit:null});
  });
  it('passes a real wall point as the direct top candidate without pretending it is a ceiling',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({hits:[{y:2.4,normal:[0,0,1]},{y:3}]});
    expect(s.diagnostic.getCurrentAimFrame()?.hit).toMatchObject({normalY:0,position:{y:2.4}});
  });
  it.each([{noViewer:true},{emulated:true},{stereo:true},{badProjection:true}])('never estimates using an invalid or unavailable tracked view (%j)',async options=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame(options);expect(s.diagnostic.getCurrentAimFrame()).toBeNull();
  });
  it('stale getter rejects the frame, invalidates epoch, and does not recursively publish',async()=>{
    const s=await setup();await s.ready();const old=s.diagnostic.getCurrentAimFrame()!.epoch;s.onUpdate.mockClear();s.onUpdate.mockImplementation(()=>s.diagnostic.getCurrentAimFrame());
    s.setNow(1300);s.windowFrame();expect(s.diagnostic.getCurrentAimFrame()).toBeNull();expect(s.onUpdate).toHaveBeenCalledTimes(1);
    s.frame();expect(s.diagnostic.getCurrentAimFrame()!.epoch).toBeGreaterThan(old);
  });
  it('screen visibility and reference reset remove the ray as well as the hit',async()=>{
    const s=await setup();await s.ready();s.session.visibilityState='hidden';s.session.dispatchEvent(new Event('visibilitychange'));expect(s.diagnostic.getCurrentAimFrame()).toBeNull();
    s.session.visibilityState='visible';s.session.dispatchEvent(new Event('visibilitychange'));s.setNow(1032);s.frame();expect(s.diagnostic.getCurrentAimFrame()).not.toBeNull();
    threeState.renderers.at(-1)!.reference.dispatchEvent(new Event('reset'));expect(s.diagnostic.getCurrentAimFrame()).toBeNull();
  });
  it('rebuilds a changed asymmetric center ray and blocks estimation while its source is pending',async()=>{
    const s=await setup();await s.ready();s.setNow(1032);s.frame({shift:.2});expect(s.diagnostic.getCurrentAimFrame()).toBeNull();expect(s.sources[0].cancel).toHaveBeenCalledOnce();
    await flush();s.setNow(1048);s.frame({shift:.2});const f=s.diagnostic.getCurrentAimFrame()!;expect(f.direction.x).toBeGreaterThan(0);
    expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(2);expect(s.session.requestHitTestSource.mock.calls[1][0].offsetRay!.direction.x).toBeCloseTo(f.direction.x);
  });
  it('blocks browser pinch zoom between frames and allows a new source after normal scale returns',async()=>{
    const s=await setup();await s.ready();vi.stubGlobal('visualViewport',{scale:2,offsetLeft:0,offsetTop:0});expect(s.diagnostic.getCurrentAimFrame()).toBeNull();expect(s.sources[0].cancel).toHaveBeenCalledOnce();
    vi.stubGlobal('visualViewport',{scale:1,offsetLeft:0,offsetTop:0});s.setNow(1032);s.frame();expect(s.diagnostic.getCurrentAimFrame()).toBeNull();await flush();s.setNow(1048);s.frame();expect(s.diagnostic.getCurrentAimFrame()).not.toBeNull();
  });
  it('does not discard intermediate real tracking states under UI throttling',async()=>{
    const s=await setup();await s.ready();s.onUpdate.mockClear();s.setNow(1032);s.frame({hits:[]});s.setNow(1048);s.frame({hits:[]});expect(s.onUpdate).toHaveBeenCalledTimes(2);
  });
  it('cancels a center source that arrives after stop and never returns a stopped ray',async()=>{
    const s=await setup({deferred:true});s.frame();expect(s.pending).toHaveLength(1);await s.diagnostic.stop();s.pending[0]();await flush();expect(s.sources[0].cancel).toHaveBeenCalledOnce();expect(s.diagnostic.getCurrentAimFrame()).toBeNull();
  });
  it('cancels late obsolete center sources and never lets their rejection end the newest configuration',async()=>{
    const s=await setup({deferred:true});s.frame();s.setNow(1016);s.frame({shift:.2});
    s.rejectPending[0](new Error('obsolete request'));await flush();expect(s.session.end).not.toHaveBeenCalled();
    s.pending[1]();await flush();s.setNow(1032);s.frame({shift:.2});expect(s.diagnostic.getCurrentAimFrame()?.direction.x).toBeGreaterThan(0);
    s.setNow(1048);s.frame({shift:.3});s.setNow(1064);s.frame({shift:.4});s.pending[2]();await flush();expect(s.sources[2].cancel).toHaveBeenCalledOnce();expect(s.diagnostic.getCurrentAimFrame()).toBeNull();
    s.pending[3]();await flush();s.setNow(1080);s.frame({shift:.4});expect(s.diagnostic.getCurrentAimFrame()?.timestamp).toBe(1080);
  });
  it('tiny center-ray numeric jitter does not starve pending source creation',async()=>{
    const s=await setup();await s.ready();for(let i=0;i<10;i++){s.setNow(1032+i*16);s.frame({shift:(i%2)*1e-6});}
    expect(s.session.requestHitTestSource).toHaveBeenCalledTimes(1);expect(s.diagnostic.getCurrentAimFrame()).not.toBeNull();
  });
  it('returns detached origin, direction and hit snapshots',async()=>{
    const s=await setup();await s.ready();const f=s.diagnostic.getCurrentAimFrame()!;f.origin.x=99;f.direction.z=0;f.hit!.position.y=99;
    expect(s.diagnostic.getCurrentAimFrame()).toMatchObject({origin:{x:0},direction:{z:-1},hit:{position:{y:0}}});
  });
});
