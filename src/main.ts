import './ui/styles.css';
import { initPhysics } from './sim/sim';
import { App } from './app';

async function boot(): Promise<void> {
  await initPhysics();
  const container = document.getElementById('app')!;
  new App(container).start();
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="color:#ff6a6a;padding:24px">Babo Violent 3 failed to boot:\n${err?.stack ?? err}</pre>`;
});
