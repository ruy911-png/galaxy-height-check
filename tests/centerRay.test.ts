import {describe,it,expect} from 'vitest';
import {createCenterRayPlan} from '../src/autoRay';
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function pose(offset=0){const projection=new Float32Array([2,0,0,0,0,3,0,0,offset,-.12,-1.002,-1,0,0,-.2002,0]);const transform={matrix:identity()};return {emulatedPosition:false,transform,views:[{transform,projectionMatrix:projection}]} as unknown as XRViewerPose;}
describe('actual screen-center ray',()=>{
 it('uses the real asymmetric camera optical center rather than an assumed viewer-forward ray',()=>{const ray=createCenterRayPlan(pose(.2))!;expect(ray.direction.x/-ray.direction.z).toBeCloseTo(.1);expect(ray.direction.y/-ray.direction.z).toBeCloseTo(-.04);expect(ray.direction.w).toBe(0);expect(ray.origin.w).toBe(1);});
 it('rejects an untracked or multi-view camera',()=>{const p=pose();expect(createCenterRayPlan({...p,emulatedPosition:true})).toBeNull();expect(createCenterRayPlan({...p,views:[...p.views,...p.views]})).toBeNull();});
 it('incorporates eye offset relative to the viewer',()=>{const p=pose();const m=identity();m[12]=.03;const view={...p.views[0],transform:{matrix:m}};const ray=createCenterRayPlan({...p,views:[view]} as unknown as XRViewerPose)!;expect(ray.origin.x).toBeCloseTo(.03);});
});
