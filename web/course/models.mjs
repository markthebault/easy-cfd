// Transparent teaching models. These functions never call a CFD solver.
const radians = degrees => degrees * Math.PI / 180;
export function forceModel({speed=100,density=1.225,area=2.2,cd=.32,cl=-.4,length=4.2}) {
  const u=speed/3.6,q=.5*density*u*u;
  return {u,q,drag:q*area*cd,lift:q*area*cl,downforce:-q*area*cl,power:q*area*cd*u/1000,re:u*length/1.5e-5,mach:u/343};
}
export function wingModel({speed=100,span=1.7,chord=.32,angle=6,localRatio=1}) {
  const area=span*chord,ar=span/chord,q=.5*1.225*(speed/3.6*localRatio)**2,e=.8;
  const slope=2*Math.PI/(1+2/(e*ar)),cn=slope*radians(angle+2),cdi=cn*cn/(Math.PI*e*ar);
  return {area,ar,q,cn,cdi,cd:.02+cdi,downforce:q*area*cn,drag:q*area*(.02+cdi),extrapolated:angle>10};
}
export function diffuserModel({height=.14,length=.95,angle=7}) {
  const exit=height+length*Math.tan(radians(angle)),ratio=exit/height,u1=35,q1=.5*1.225*u1*u1;
  return {exit,ratio,exitSpeed:u1/ratio,recoveryFraction:1-1/(ratio*ratio),recovery:q1*(1-1/(ratio*ratio))};
}
export function balanceModel({wheelbase=2.6,frontLoad=150,frontPosition=-.4,rearLoad=500,rearPosition=3}) {
  const total=frontLoad+rearLoad,moment=frontLoad*frontPosition+rearLoad*rearPosition,rear=moment/wheelbase,front=total-rear;
  return {total,moment,front,rear,frontFraction:Math.abs(total)>1e-9?front/total:null};
}
export function gciModel({fine=.3,medium=.306,coarse=.3195,ratio=1.5}) {
  const d21=medium-fine,d32=coarse-medium;
  if (![fine,medium,coarse,ratio].every(Number.isFinite)||ratio<=1||fine===0||d21===0||d32===0||d21*d32<=0||Math.abs(d32)<=Math.abs(d21)) return {valid:false,reason:'Need nonzero fine value, r > 1, and nonzero monotonic differences that shrink toward the fine grid. Do not force GCI on this sequence.'};
  const order=Math.log(Math.abs(d32/d21))/Math.log(ratio),denominator=ratio**order-1;
  return {valid:true,order,extrapolated:fine+(fine-medium)/denominator,gci:1.25*Math.abs(d21/fine)/denominator};
}
export function yawModel({roadSpeed=100,headwind=0,crosswind=5}) {
  const road=roadSpeed/3.6,longitudinal=road+headwind,airspeed=Math.hypot(longitudinal,crosswind);
  return {road,longitudinal,airspeed,yaw:Math.atan2(crosswind,longitudinal)*180/Math.PI,q:.5*1.225*airspeed*airspeed};
}
export function frontier(candidates) {
  return candidates.filter(a=>!candidates.some(b=>b!==a&&b.drag<=a.drag&&b.load>=a.load&&(b.drag<a.drag||b.load>a.load)));
}
