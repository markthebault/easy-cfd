import { expect, test } from '@playwright/test';

test.setTimeout(60_000);
test('airflow moves visibly across a stationary car without a dense glowing overlay', async ({ page }) => {
  const errors: string[]=[];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/?workspace=track');
  await expect(page.locator('.track-lab')).toHaveAttribute('data-ready','true');
  await page.keyboard.press('Space');
  const result=await page.evaluate(()=>{
    const s=(window as any).__trackStage;
    cancelAnimationFrame(s.frame);
    const particles=s.car.smoke;
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=600;
    const ctx=canvas.getContext('2d')!;
    const read=()=>{
      s.renderer.render(s.scene,s.camera);
      ctx.drawImage(s.renderer.domElement,0,0,canvas.width,canvas.height);
      return ctx.getImageData(0,0,canvas.width,canvas.height).data.slice();
    };
    particles.mesh.visible=false;const clear=read();
    particles.mesh.visible=true;particles.playing=true;
    for(let i=0;i<140;i++)particles.step(.05,s.camera);
    const first=read();
    for(let i=0;i<4;i++)particles.step(.05,s.camera);
    const moved=read();
    particles.playing=false;particles.step(.05,s.camera);const paused=read();
    let visible=0,changed=0,pausedDelta=0;
    for(let i=0;i<clear.length;i+=4){
      const diff=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      if(diff(clear,first)>25)visible++;
      if(diff(first,moved)>25)changed++;
      pausedDelta+=diff(moved,paused);
    }
    return {visible,changed,pausedDelta,pixels:canvas.width*canvas.height,frame:s.car.group.position.toArray()};
  });
  expect(result.visible).toBeGreaterThan(150);
  expect(result.changed).toBeGreaterThan(100);
  expect(result.visible/result.pixels).toBeLessThan(.04);
  expect(result.pausedDelta).toBe(0);
  expect(errors).toEqual([]);
});
