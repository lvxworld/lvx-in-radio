/** The same generation dial and power-button finish in On air and the mini player. */
export function generationAppearance(enabled, color) {
  return {
    genColor: enabled ? color : '#b9b2a8',
    genIcon: enabled ? '#121110' : '#8a847b',
    genBg: enabled ? `radial-gradient(circle at 50% 40%,#fff1d6 0%,${color} 60%)` : 'linear-gradient(180deg,#2c2926 0%,#181614 100%)',
    genShadow: enabled ? `inset 0 3px 7px rgba(0,0,0,.45),inset 0 -1px 0 rgba(255,255,255,.3),0 0 0 3px #121110,0 0 0 4.5px ${color},0 0 22px ${color}` : '0 6px 14px rgba(0,0,0,.6),0 1px 0 rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.1),0 0 0 3px #121110,0 0 0 4px rgba(255,255,255,.08)',
  };
}

function setup(cv,w,h){const dpr=Math.min(2,window.devicePixelRatio||1);if(cv.width!==Math.round(w*dpr)){cv.width=Math.round(w*dpr);cv.height=Math.round(h*dpr)}const x=cv.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);return x}

function tint(hex,alpha){const n=parseInt(hex.slice(1),16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+alpha+')'}

function dialAura(x,cx,cy,color,t){const pulse=.5+.5*Math.sin(t*1.4);const g=x.createRadialGradient(cx+Math.sin(t*.35)*5,cy-12,15,cx,cy,148);g.addColorStop(0,tint(color,.035+pulse*.025));g.addColorStop(.6,tint(color,.012));g.addColorStop(1,tint(color,0));x.fillStyle=g;x.fillRect(0,0,320,320)}

function drawCenterBulb(x,cx,cy,color,t,strength,phase){
  const breath=.5+.5*Math.sin(t*1.7+phase),r=39+breath*10,lightY=cy-24;
  x.save();x.globalAlpha=1;x.globalCompositeOperation='screen';
  x.beginPath();x.arc(cx,cy,79,0,Math.PI*2);x.clip();
  const glow=x.createRadialGradient(cx,lightY,2,cx,lightY,r);
  glow.addColorStop(0,tint(color,(.2+breath*.18)*strength));
  glow.addColorStop(.38,tint(color,(.12+breath*.1)*strength));
  glow.addColorStop(1,tint(color,0));
  x.fillStyle=glow;x.fillRect(cx-79,cy-79,158,158);
  const core=x.createRadialGradient(cx,lightY,1,cx,lightY,17+breath*3);
  core.addColorStop(0,'rgba(255,238,218,'+((.05+breath*.06)*strength)+')');
  core.addColorStop(1,'rgba(255,238,218,0)');
  x.fillStyle=core;x.fillRect(cx-79,cy-79,158,158);x.restore();
}

export function drawGenerationDial(cv, { enabled:on, active:item, progress = 0, color = '#f2a33a', levels, time:t = 0 }) {
  const size=cv.clientWidth||236,S=size/320,x=setup(cv,size,size),C=160,S0=-Math.PI/2,N=24;
  if (!on) color='#6f6a63';
  x.scale(S,S);x.clearRect(0,0,320,320);if(on)dialAura(x,C,C,color,t);x.lineCap='round';x.lineWidth=12;x.strokeStyle='#22201d';x.beginPath();x.arc(C,C,140,0,Math.PI*2);x.stroke();
  if(on){const share=item?Math.max(.02,progress/100):1;x.save();x.shadowColor=color;x.shadowBlur=12+3*Math.sin(t*1.5);x.strokeStyle=item?color:tint(color,.55);x.beginPath();x.arc(C,C,140,S0,S0+Math.PI*2*share);x.stroke();x.restore()}
  for(let i=0;i<N;i++){const a=S0+i/N*Math.PI*2,major=i%6===0,wave=on?Math.max(levels[(i*5)%60],.08+.24*(.5+.5*Math.sin(t*(item?3.2:1.6)-i*.5))):0,r0=major?92:98,r1=major?122:112+wave*8;x.strokeStyle=on?tint(color,.5+wave*.5):'rgba(243,236,226,.2)';x.lineWidth=major?5:3.5;x.beginPath();x.moveTo(C+Math.cos(a)*r0,C+Math.sin(a)*r0);x.lineTo(C+Math.cos(a)*r1,C+Math.sin(a)*r1);x.stroke()}
  const g=x.createRadialGradient(C,C-12,4,C,C,79);g.addColorStop(0,on?tint(color,.2):'#211e19');g.addColorStop(.55,'#201d19');g.addColorStop(1,'#171513');x.fillStyle=g;x.beginPath();x.arc(C,C,79,0,Math.PI*2);x.fill();drawCenterBulb(x,C,C,color,t,on?.7:.15,.4);x.strokeStyle=on?color:'rgba(255,255,255,.07)';x.lineWidth=1;x.beginPath();x.arc(C,C,79,0,Math.PI*2);x.stroke()}
