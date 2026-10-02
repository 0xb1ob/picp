export interface GraphBox { x:number; y:number; w:number; h:number }
type Point=[number,number];
export function edgePoints(a:GraphBox,b:GraphBox):Point[] {
 if(a.y===b.y && a.x!==b.x && Math.abs(a.x-b.x)<=160) {
  const right=a.x<b.x;
  return [[a.x+(right ? a.w : 0),a.y+a.h/2],[b.x+(right ? 0 : b.w),b.y+b.h/2]];
 }
 // The fixed-column grid leaves 36px between jobs and 30px between rows.
 if(a.y===b.y) return [[a.x+a.w/2,a.y+a.h],[a.x+a.w/2,a.y+a.h+15],[b.x+b.w/2,a.y+a.h+15],[b.x+b.w/2,b.y+b.h]];
 const down=a.y<b.y,targetY=down ? b.y : b.y+b.h,gapY=targetY+(down ? -15 : 15);
 return [[a.x,a.y+a.h/2],[a.x-18,a.y+a.h/2],[a.x-18,gapY],[b.x+b.w/2,gapY],[b.x+b.w/2,targetY]];
}
