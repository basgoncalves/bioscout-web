const K = await import('./kinematics.js');
const D = await import('./detect.js');
const G = 9.80665;
function clip({fps=60,jumpH=0,cmv=0.25,pxPerM=500,shank=0.42,armOverhead=false}) {
  const H=[],FOOT=[]; const stand=0.95, dip=stand-cmv;
  const flight = jumpH>0.001 ? 2*Math.sqrt(2*jumpH/G) : 0;
  const dipN=Math.round(.4*fps), pushN=Math.round(.3*fps), flightN=Math.round(flight*fps);
  for(let i=0;i<Math.round(.5*fps);i++){H.push(stand);FOOT.push(0);}
  for(let i=0;i<dipN;i++){H.push(stand-cmv*(i+1)/dipN);FOOT.push(0);}
  for(let i=0;i<pushN;i++){H.push(dip+cmv*(i+1)/pushN);FOOT.push(0);}
  const v=G*flight/2;
  for(let i=0;i<flightN;i++){const s=(i+1)/fps,y=v*s-.5*G*s*s;H.push(stand+y);FOOT.push(Math.max(0,y));}
  for(let i=0;i<Math.round(.7*fps);i++){H.push(stand);FOOT.push(0);}
  const poses={};
  H.forEach((h,i)=>{
    const hipY=1000-h*pxPerM, footY=1000-FOOT[i]*pxPerM;
    const kneeY=footY-shank*pxPerM, shY=hipY-0.45*pxPerM;
    // knee forward and trunk leaning as the hip drops -- otherwise hip, knee
    // and ankle stay collinear and no joint flexes at all
    const drop=(stand-h), kneeX=drop*0.9*pxPerM, trunkX=-drop*0.5*pxPerM;
    const wrY = armOverhead ? shY-150 : shY+220;
    poses[i]={left_shoulder:[240+trunkX,shY],right_shoulder:[260+trunkX,shY],
      left_hip:[245,hipY],right_hip:[255,hipY],
      left_knee:[245+kneeX,kneeY],right_knee:[255+kneeX,kneeY],
      left_ankle:[245,footY],right_ankle:[255,footY],
      left_foot_index:[265,footY+4],right_foot_index:[275,footY+4],
      left_elbow:[235+trunkX,shY+110],right_elbow:[265+trunkX,shY+110],
      left_wrist:[235+trunkX,wrY],right_wrist:[265+trunkX,wrY],
      left_ear:[245+trunkX,shY-70],right_ear:[255+trunkX,shY-70],nose:[250+trunkX,shY-80]};
  });
  return poses;
}
const cases = [
  ['CMJ  (0.30 m, dip 0.25)', clip({jumpH:0.30,cmv:0.25}), 'cmj'],
  ['SJ   (0.30 m, no dip)',   clip({jumpH:0.30,cmv:0.0}),  'sj'],
  ['squat (no flight)',       clip({jumpH:0,   cmv:0.30}), 'squat'],
  ['CMJ at 30 fps',           clip({fps:30,jumpH:0.30,cmv:0.25}), 'cmj'],
  ['small hop 0.10 m',        clip({jumpH:0.10,cmv:0.20}), 'cmj'],
];
for (const [name, poses, want] of cases) {
  const c = D.classify(poses);
  const sc = Object.entries(c.scores).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`${k} ${v.toFixed(2)}`).join('  ');
  console.log(`${name.padEnd(24)} -> ${String(c.activity).padEnd(6)} ${c.activity===want?'OK ':'XX '} conf ${c.confidence.toFixed(2)}  [${sc}]`);
}
