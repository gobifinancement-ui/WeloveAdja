/* Dessin du billet sur une toile.
 *
 * Partage entre la page d'accueil (recuperation du billet) et la page de
 * retour de paiement : une seule mise en page, donc aucun risque que les deux
 * divergent. Elle suit celle du PDF produit par le serveur.
 *
 * La toile sert a deux choses : l'apercu a l'ecran, et le telechargement en
 * image. Cela evite d'embarquer un moteur de rendu PDF cote navigateur.
 */

(function (global) {
const T = { clair:'#f4f7f2', vert:'#2fa84f', vertFonce:'#12662c', sombre:'#0c2b17', blanc:'#ffffff' };

const charger = src => new Promise(res => {
  if(!src) return res(null);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => res(img);
  img.onerror = () => res(null);   // image manquante : le billet reste valable
  img.src = src;
});

function coinsArrondis(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function dessiner(canvas, billet, actifs){
  // 1200x800 : deux fois la taille du PDF, pour rester net une fois
  // enregistre puis rouvert ou imprime.
  const W = 1200, H = 800, k = 2;   // k = echelle par rapport au PDF
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const mid = W / 2;

  c.fillStyle = T.clair; c.fillRect(0,0,W,H);

  if(actifs.fond){
    // "cover" ancre en bas : sur une photo de concert, la foule est en bas.
    const r = Math.max(W / actifs.fond.width, H / actifs.fond.height);
    const lw = actifs.fond.width * r, lh = actifs.fond.height * r;
    c.drawImage(actifs.fond, (W - lw) / 2, H - lh, lw, lh);
    const g = c.createLinearGradient(0,0,0,H);
    g.addColorStop(0,   'rgba(244,247,242,.95)');
    g.addColorStop(0.55,'rgba(244,247,242,.90)');
    g.addColorStop(0.78,'rgba(244,247,242,.55)');
    g.addColorStop(1,   'rgba(244,247,242,.12)');
    c.fillStyle = g; c.fillRect(0,0,W,H);
  }

  c.fillStyle = T.vert;
  c.beginPath(); c.moveTo(0,0); c.lineTo(148*k,0); c.lineTo(0,94*k); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(W,0); c.lineTo(W-148*k,0); c.lineTo(W,94*k); c.closePath(); c.fill();

  c.save();
  c.globalAlpha = actifs.fond ? 0.62 : 1;
  c.fillStyle = T.sombre;
  c.beginPath();
  c.moveTo(0, H-64*k);
  c.bezierCurveTo(W*0.33, H-24*k, W*0.67, H-24*k, W, H-64*k);
  c.lineTo(W,H); c.lineTo(0,H); c.closePath(); c.fill();
  c.restore();

  const L = 70*k;
  if(actifs.logo){
    c.drawImage(actifs.logo, 22*k, 10*k, L, L);
    c.drawImage(actifs.logo, W - 22*k - L, 10*k, L, L);
  }

  const cx = (actifs.logo ? 144 : 96) * k, cw = W - cx*2, ch = 54*k;
  if(actifs.bandeau){
    const e = Math.min(cw / actifs.bandeau.width, ch / actifs.bandeau.height);
    const lw = actifs.bandeau.width * e, lh = actifs.bandeau.height * e;
    const x = cx + (cw - lw)/2, y = 12*k + (ch - lh)/2;
    c.save(); coinsArrondis(c, x, y, lw, lh, Math.min(14*k, lh/2)); c.clip();
    c.drawImage(actifs.bandeau, x, y, lw, lh); c.restore();
  }else{
    c.fillStyle = T.sombre; coinsArrondis(c, cx, 12*k, cw, ch, 13*k); c.fill();
    c.fillStyle = T.blanc; c.font = '700 ' + (21*k) + 'px system-ui,sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText((CFG.eventName||'FEJA').toUpperCase(), mid, 12*k + ch/2);
  }

  c.textAlign = 'center'; c.textBaseline = 'top';
  c.fillStyle = T.sombre; c.font = '700 ' + (11.5*k) + 'px system-ui,sans-serif';
  const annee = new Date().getFullYear();
  c.fillText('Édition ' + annee, mid, 92*k);
  c.strokeStyle = T.vert; c.lineWidth = 1.6*k;
  c.beginPath(); c.moveTo(mid-112*k, 98*k); c.lineTo(mid-56*k, 98*k); c.stroke();
  c.beginPath(); c.moveTo(mid+56*k, 98*k); c.lineTo(mid+112*k, 98*k); c.stroke();

  const qr = 150*k, qrX = mid - qr/2, qrY = 98*k;
  c.fillStyle = T.blanc; c.strokeStyle = T.vert; c.lineWidth = 2.4*k;
  coinsArrondis(c, qrX-10*k, qrY-10*k, qr+20*k, qr+20*k, 12*k); c.fill(); c.stroke();
  if(actifs.qr) c.drawImage(actifs.qr, qrX, qrY, qr, qr);

  const yCode = qrY + qr + 20*k, cwc = 220*k, chc = 42*k;
  c.fillStyle = T.sombre; c.strokeStyle = T.vert; c.lineWidth = 2*k;
  coinsArrondis(c, mid - cwc/2, yCode, cwc, chc, 11*k); c.fill(); c.stroke();
  c.fillStyle = T.blanc; c.font = '700 ' + (24*k) + 'px system-ui,sans-serif';
  c.textBaseline = 'middle';
  c.save(); c.letterSpacing = (4*k) + 'px';
  c.fillText(billet.code || '------', mid, yCode + chc/2);
  c.restore();

  const yScan = yCode + chc + 11*k;
  c.textBaseline = 'top';
  c.fillStyle = T.vertFonce; c.font = '700 ' + (8*k) + 'px system-ui,sans-serif';
  c.save(); c.letterSpacing = (2*k) + 'px';
  c.fillText('SCANNEZ POUR VOS INFOS', mid, yScan);
  c.restore();
  c.strokeStyle = T.vert; c.lineWidth = 1.2*k;
  c.beginPath(); c.moveTo(mid-148*k, yScan+4*k); c.lineTo(mid-86*k, yScan+4*k); c.stroke();
  c.beginPath(); c.moveTo(mid+86*k, yScan+4*k); c.lineTo(mid+148*k, yScan+4*k); c.stroke();

  const yPied = H - 34*k;
  c.textAlign = 'left';
  c.fillStyle = T.vert; c.font = '700 ' + (7*k) + 'px system-ui,sans-serif';
  c.fillText('PARTICIPANT', 28*k, yPied);
  c.fillStyle = T.blanc; c.font = '700 ' + (11.5*k) + 'px system-ui,sans-serif';
  c.fillText(billet.nom || '-', 28*k, yPied + 10*k);

  c.textAlign = 'right';
  c.fillStyle = T.vert; c.font = '700 ' + (7*k) + 'px system-ui,sans-serif';
  c.fillText('LIEU', W - 28*k, yPied);
  c.fillStyle = '#dceadf'; c.font = '700 ' + (9.5*k) + 'px system-ui,sans-serif';
  c.fillText(billet.lieu || '-', W - 28*k, yPied + 11*k);
}


  /* Charge les images de marque, une seule fois pour plusieurs billets. */
  async function chargerActifs(marque) {
    const m = marque || {};
    return {
      logo: await charger(m.logoUrl || ''),
      bandeau: await charger('/uploads/branding/wordmark.png'),
      fond: await charger('/uploads/branding/ticket-bg.jpg'),
    };
  }

  global.TicketCanvas = {
    dessiner,
    charger,
    chargerActifs,
  };
})(window);
