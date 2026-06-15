import { describe, it, expect } from 'vitest';
import { segAABB } from '../../src/core/math';

// Reference = the pre-unroll slab algorithm, inlined here, to pin bit-equality.
function ref(x0:number,y0:number,x1:number,y1:number,cx:number,cy:number,w:number,h:number):number{
  const dx=x1-x0, dy=y1-y0;
  const minX=cx-w/2,maxX=cx+w/2,minY=cy-h/2,maxY=cy+h/2;
  let tmin=0,tmax=1;
  for(const [p,d,lo,hi] of [[x0,dx,minX,maxX],[y0,dy,minY,maxY]] as const){
    if(Math.abs(d)<1e-12){ if(p<lo||p>hi) return -1; }
    else{ let t1=(lo-p)/d,t2=(hi-p)/d; if(t1>t2)[t1,t2]=[t2,t1]; tmin=Math.max(tmin,t1); tmax=Math.min(tmax,t2); if(tmin>tmax) return -1; }
  }
  return tmin;
}

describe('segAABB scalar unroll bit-equality', () => {
  const cases: number[][] = [
    [0,0, 5,0, 2,0, 1,1], [-3,-3, 3,3, 0,0, 2,2], [0,0, 0,0, 0,0, 1,1],
    [-5,1, 5,1, 0,0, 4,0.5], [1,1, 1,9, 1,5, 0.001,3], [10,10, -10,-10, 0,0, 6,2],
  ];
  it('matches the reference slab method exactly', () => {
    for (const c of cases) expect(segAABB(c[0],c[1],c[2],c[3],c[4],c[5],c[6],c[7])).toBe((ref as any)(...c));
  });
});
