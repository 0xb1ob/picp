export interface GraphBox { x:number; y:number; w:number; h:number }
type Point=[number,number];
export function edgePoints(a:GraphBox,b:GraphBox):Point[] {
 if(a.x===b.x && Math.abs(a.y-b.y)===94) {
  const down=a.y<b.y,x=a.x+12;
  return [[x,down ? a.y+a.h : a.y],[x,down ? b.y : b.y+b.h]];
 }
 // Column gutters and the 36px card gaps keep skipped, cyclic and cross-column edges off cards.
 const gapY=b.y+b.h+18;
 return [[a.x,a.y+a.h/2],[a.x-6,a.y+a.h/2],[a.x-6,gapY],[b.x+12,gapY],[b.x+12,b.y+b.h]];
}
