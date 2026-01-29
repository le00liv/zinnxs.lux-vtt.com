class LuxVTT {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        this.fogCanvas = document.createElement('canvas');
        this.fogCtx = this.fogCanvas.getContext('2d');

        this.channel = new BroadcastChannel('lux_vtt_channel');

        this.state = {
            mapImg: null, mapSrc: null, 
            tokens: [], initiative: [], initIndex: -1, 
            drawings: [], notes: "", attachments: [],
            gridSize: 50, gridVisible: true,
            pan: { x: 0, y: 0 }, scale: 1,
            fog: { enabled: true, opacity: 0.5 },
            sync: false
        };

        this.local = {
            tool: 'pan',
            drag: { active: false, start: {x:0,y:0}, curr: {x:0,y:0} },
            selectedTokenId: null, volume: 0.5, fogDrawn: false,
            vignetteOpacity: 0.8, brushSize: 5
        };

        this.init();
    }

    init() {
        this.resize();
        window.onresize = () => this.resize();
        this.resetFog();
        this.setupInputs();
        this.setupMouse();
        this.loadSessionFromBrowser();
        this.loop();
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.fogCanvas.width = 4000;
        this.fogCanvas.height = 4000;
        if(this.state.fog.enabled && !this.local.fogDrawn) this.resetFog();
    }

    loop() {
        requestAnimationFrame(() => this.loop());
        this.draw();
        if(this.state.sync) this.broadcast();
    }

    draw() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.save();

        ctx.translate(this.state.pan.x, this.state.pan.y);
        ctx.scale(this.state.scale, this.state.scale);

        // 1. Mapa
        if (this.state.mapImg) ctx.drawImage(this.state.mapImg, 0, 0);
        else { ctx.fillStyle = "#020617"; ctx.fillRect(-5000, -5000, 10000, 10000); }

        // 2. Grid
        if (this.state.gridVisible) this.drawGrid(ctx);

        // 3. Desenhos
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        this.state.drawings.forEach(d => {
            ctx.beginPath();
            ctx.strokeStyle = d.tool === 'eraser' ? "rgba(0,0,0,1)" : d.color;
            ctx.lineWidth = d.width || 4;
            ctx.moveTo(d.path[0].x, d.path[0].y);
            d.path.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.stroke();
        });

        if ((this.local.tool === 'draw' || this.local.tool === 'eraser') && this.local.drag.active && this.currentPath) {
            ctx.beginPath();
            ctx.strokeStyle = this.local.tool==='eraser'?"#000":document.getElementById('brush-color').value;
            ctx.lineWidth = this.local.tool==='eraser'? (this.local.brushSize*3) : this.local.brushSize;
            ctx.moveTo(this.currentPath[0].x, this.currentPath[0].y);
            this.currentPath.forEach(p => ctx.lineTo(p.x, p.y));
            ctx.stroke();
        }

        // 4. Tokens
        this.state.tokens.forEach(t => {
            if(!t.visible) return;
            const s = t.size * this.state.gridSize;
            if (t.id === this.local.selectedTokenId) {
                ctx.shadowBlur=15; ctx.shadowColor="#38bdf8"; ctx.strokeStyle="#38bdf8"; ctx.lineWidth=3;
                ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2+4, 0, Math.PI*2); ctx.stroke(); ctx.shadowBlur=0;
            }
            ctx.save(); ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, Math.PI*2); ctx.clip();
            if (t.img) ctx.drawImage(t.img, t.x, t.y, s, s);
            else { ctx.fillStyle="#1e40af"; ctx.fillRect(t.x, t.y, s, s); ctx.fillStyle="#fff"; ctx.font="bold 20px Arial"; ctx.textAlign="center"; ctx.fillText(t.name[0], t.x+s/2, t.y+s/2+7); }
            ctx.restore();
            ctx.strokeStyle="#fff"; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(t.x+s/2, t.y+s/2, s/2, 0, Math.PI*2); ctx.stroke();
        });

        // 5. Fog of War
        if (this.state.fog.enabled) {
            ctx.save(); ctx.globalAlpha = this.state.fog.opacity;
            ctx.drawImage(this.fogCanvas, 0, 0); ctx.restore();
        }

        // 6. UI & PREVIEWS
        if (this.local.drag.active) {
            const m = this.getMouse(this.local.drag.curr);
            const s = this.getMouse(this.local.drag.start);
            
            // Preview de Fog (Quadrado Colorido)
            if (this.local.tool.includes('fog')) {
                ctx.fillStyle = this.local.tool==='fog-reveal' ? "rgba(0, 255, 0, 0.4)" : "rgba(255, 0, 0, 0.4)";
                ctx.fillRect(s.x, s.y, m.x-s.x, m.y-s.y);
                ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
                ctx.strokeRect(s.x, s.y, m.x-s.x, m.y-s.y);
            }

            // Régua
            if (this.local.tool==='ruler'){
                ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(m.x, m.y);
                ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 3; ctx.setLineDash([10,5]); ctx.stroke(); ctx.setLineDash([]);
                const val = (Math.hypot(m.x-s.x, m.y-s.y)/this.state.gridSize)*1.5;
                ctx.fillStyle="#000"; ctx.fillRect(m.x+10, m.y, 70, 25);
                ctx.fillStyle="#fbbf24"; ctx.font="bold 14px Arial"; ctx.fillText(val.toFixed(1)+"m", m.x+15, m.y+18);
            }
        }
        ctx.restore();
    }

    drawGrid(ctx) {
        ctx.strokeStyle = "rgba(56, 189, 248, 0.1)"; ctx.lineWidth = 1; ctx.beginPath();
        for(let i=-5000; i<5000; i+=this.state.gridSize){
            ctx.moveTo(i, -5000); ctx.lineTo(i, 5000); ctx.moveTo(-5000, i); ctx.lineTo(5000, i);
        } ctx.stroke();
    }

    // --- CONTROLES ---
    setupMouse() {
        this.canvas.addEventListener('mousedown', e => {
            this.local.drag.active = true;
            this.local.drag.start = {x:e.clientX, y:e.clientY}; this.local.drag.curr = {x:e.clientX, y:e.clientY};
            const w = this.getMouse(this.local.drag.start);

            if(this.local.tool==='select'){
                const t = [...this.state.tokens].reverse().find(x => x.visible && w.x>=x.x && w.x<=x.x+(x.size*50) && w.y>=x.y && w.y<=x.y+(x.size*50));
                this.local.selectedTokenId = t ? t.id : null;
                if(t) this.local.drag.offset = {x: w.x-t.x, y: w.y-t.y};
                else this.local.tool = 'pan-temp';
                this.updateTokenUI();
            } else if(this.local.tool==='draw' || this.local.tool==='eraser'){
                this.currentPath = [w];
            }
        });

        this.canvas.addEventListener('mousemove', e => {
            if(!this.local.drag.active) return;
            const dx = e.clientX - this.local.drag.curr.x;
            const dy = e.clientY - this.local.drag.curr.y;
            this.local.drag.curr = {x:e.clientX, y:e.clientY};
            const w = this.getMouse(this.local.drag.curr);

            if(this.local.tool==='pan' || this.local.tool==='pan-temp'){
                this.state.pan.x += dx; this.state.pan.y += dy;
            } else if(this.local.tool==='select' && this.local.selectedTokenId){
                const t = this.state.tokens.find(x=>x.id===this.local.selectedTokenId);
                if(t){ t.x = w.x - this.local.drag.offset.x; t.y = w.y - this.local.drag.offset.y; }
            } else if(this.local.tool==='draw' || this.local.tool==='eraser'){
                this.currentPath.push(w);
            }
        });

        this.canvas.addEventListener('mouseup', e => {
            if(this.local.tool.includes('fog')){
                const s=this.getMouse(this.local.drag.start), m=this.getMouse(this.local.drag.curr);
                this.applyFog(s.x, s.y, m.x-s.x, m.y-s.y, this.local.tool==='fog-reveal');
            }
            if(this.local.tool==='draw' || this.local.tool==='eraser'){
                this.state.drawings.push({ 
                    path: [...this.currentPath], 
                    color: document.getElementById('brush-color').value, 
                    tool: this.local.tool,
                    width: this.local.tool==='eraser'?(this.local.brushSize*3):this.local.brushSize 
                });
                this.currentPath = null;
            }
            if(this.local.tool==='pan-temp') this.local.tool='select';
            this.local.drag.active = false;
        });

        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this.state.scale *= e.deltaY > 0 ? 0.9 : 1.1;
        });
    }

    getMouse(p) { return { x: (p.x - this.state.pan.x)/this.state.scale, y: (p.y - this.state.pan.y)/this.state.scale }; }
    
    setTool(t) { 
        this.local.tool = t; 
        document.querySelectorAll('.btn-hud').forEach(b => b.classList.remove('active'));
        const map = {'pan':'btn-pan','select':'btn-select','ruler':'btn-ruler','draw':'btn-draw','eraser':'btn-eraser'};
        if(map[t]) document.getElementById(map[t]).classList.add('active');
        if(t.includes('fog')) document.getElementById('btn-fog').classList.add('active');
        this.canvas.style.cursor = t==='pan'?'grab':t==='select'?'default':'crosshair';
    }

    updateBrushSize(v) { this.local.brushSize = parseInt(v); }

    // --- FOG ---
    toggleFogMenu() { document.getElementById('fog-controls').classList.toggle('show'); }
    resetFog() { this.fogCtx.fillStyle="#000"; this.fogCtx.fillRect(0,0,4000,4000); this.local.fogDrawn=true; this.sendFogUpdate(); }
    applyFog(x,y,w,h,rev) { this.fogCtx.globalCompositeOperation=rev?'destination-out':'source-over'; this.fogCtx.fillStyle="#000"; this.fogCtx.fillRect(x,y,w,h); this.sendFogUpdate(); }
    setDmOpacity(v) { this.state.fog.opacity = v; }
    toggleFogVis() { this.state.fog.enabled = !this.state.fog.enabled; }

    // --- SYNC & PLAYER SCREEN ---
    openPlayerScreen() {
        const html = `<!DOCTYPE html><html><head><title>Lux Player</title><style>body{margin:0;background:#020617;overflow:hidden;}canvas{width:100vw;height:100vh;display:block;}</style></head><body><canvas id="c"></canvas><script>
        const c=document.getElementById('c'),x=c.getContext('2d'),ch=new BroadcastChannel('lux_vtt_channel');
        let st=null,m=null,f=null,im={}; window.onresize=()=>{c.width=innerWidth;c.height=innerHeight;};window.onresize();
        ch.onmessage=e=>{
            if(e.data.t==='s'){st=e.data.d; if(st.mapSrc && (!m || m.src !== st.mapSrc)){ m=new Image(); m.src = st.mapSrc; }}
            if(e.data.t==='f'){f=new Image();f.src=e.data.d;}
        };
        function d(){requestAnimationFrame(d);if(!st)return;x.clearRect(0,0,c.width,c.height);x.save();x.translate(st.pan.x,st.pan.y);x.scale(st.scale,s.scale);
        if(m)x.drawImage(m,0,0);else{x.fillStyle='#020617';x.fillRect(-5000,-5000,10000,10000);}
        if(st.grid){x.strokeStyle='rgba(56,189,248,0.1)';x.lineWidth=1;x.beginPath();for(let i=-5000;i<5000;i+=st.gridSize){x.moveTo(i,-5000);x.lineTo(i,5000);x.moveTo(-5000,i);x.lineTo(5000,i);}x.stroke();}
        st.drawings.forEach(k=>{x.beginPath();x.strokeStyle=k.tool==='eraser'?'rgba(0,0,0,1)':k.color;x.lineWidth=k.width||4;x.lineCap='round';x.moveTo(k.path[0].x,k.path[0].y);k.path.forEach(p=>x.lineTo(p.x,p.y));x.stroke();});
        st.tokens.forEach(t=>{if(!t.visible)return;let z=t.size*st.gridSize;x.save();x.beginPath();x.arc(t.x+z/2,t.y+z/2,z/2,0,6.28);x.clip();if(t.imgSrc){if(!im[t.id]){im[t.id]=new Image();im[t.id].src=t.imgSrc;}if(im[t.id].complete)x.drawImage(im[t.id],t.x,t.y,z,z);}else{x.fillStyle='#1e40af';x.fillRect(t.x,t.y,z,z);}x.restore();});
        if(f)x.drawImage(f,0,0);x.restore();}d();<\/script></body></html>`;
        
        const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
        window.open(url, "LuxPlayer", "width=800,height=600");
        setTimeout(()=>{this.broadcast();this.sendFogUpdate();},1000);
    }
    toggleSync() { this.state.sync = document.getElementById('sync-toggle').checked; }
    broadcast(){
        const safeTokens = this.state.tokens.map(t=>({id:t.id,x:t.x,y:t.y,size:t.size,name:t.name,visible:t.visible,imgSrc:t.imgSrc}));
        this.channel.postMessage({t:'s', d:{pan:this.state.pan, scale:this.state.scale, mapSrc:this.state.mapSrc, tokens:safeTokens, drawings:this.state.drawings, gridSize:this.state.gridSize, grid:this.state.gridVisible}});
    }
    sendFogUpdate(){ this.channel.postMessage({t:'f', d:this.fogCanvas.toDataURL()}); }

    // --- TOKENS ---
    setupInputs() {
        document.getElementById('map-upload').onchange = e => {
            const f = e.target.files[0];
            if(f){ const r=new FileReader(); r.onload=ev=>{const s=ev.target.result; const i=new Image(); i.onload=()=>{this.state.mapImg=i;this.state.mapSrc=s;}; i.src=s;}; r.readAsDataURL(f); }
        };
        document.getElementById('token-upload').onchange = e => this.tempToken = e.target.files[0];
        document.getElementById('session-upload').onchange = e => {
            const r=new FileReader(); r.onload=ev=>this.loadData(JSON.parse(ev.target.result)); r.readAsText(e.target.files[0]);
        };
        document.getElementById('note-file-upload').onchange = e => this.addNoteFile(e.target.files[0]);
        document.getElementById('sound-file').onchange = e => this.addSound(e.target.files[0]);
    }

    addToken() {
        const n=document.getElementById('new-token-name').value || "T";
        const t={id:Date.now(), name:n, x:window.innerWidth/2-this.state.pan.x, y:window.innerHeight/2-this.state.pan.y, size:1, img:null, imgSrc:null, visible:true};
        if(this.tempToken){ const r=new FileReader(); r.onload=ev=>{const s=ev.target.result; const i=new Image(); i.onload=()=>{t.img=i;t.imgSrc=s;}; i.src=s;}; r.readAsDataURL(this.tempToken); this.tempToken=null; }
        this.state.tokens.push(t); this.renderTokens();
    }
    renderTokens() {
        const l=document.getElementById('token-list'); l.innerHTML="";
        this.state.tokens.forEach(t=>{
            const d=document.createElement('div'); d.className='token-item';
            const eyeIcon = t.visible ? 'fa-eye' : 'fa-eye-slash';
            const eyeStyle = t.visible ? 'color:var(--accent)' : 'color:#666';
            d.innerHTML=`<span onclick="vtt.selectTokenFromList(${t.id})">${t.name}</span><button class="btn-xs" onclick="vtt.toggleTokenVis(${t.id})" style="background:none; border:none; ${eyeStyle}"><i class="fas ${eyeIcon}"></i></button>`;
            l.appendChild(d);
        });
    }
    selectTokenFromList(id) { this.local.selectedTokenId = id; this.local.tool='select'; this.updateTokenUI(); }
    toggleTokenVis(id) { const t=this.state.tokens.find(x=>x.id===id); if(t) t.visible=!t.visible; this.renderTokens(); }
    updateTokenUI() { const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t){ document.getElementById('token-controls').classList.remove('hidden'); document.getElementById('sel-token-name').innerText=t.name; } else document.getElementById('token-controls').classList.add('hidden'); }
    resizeToken(d){ const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t) t.size=Math.max(0.5, t.size+d); }
    deleteToken(){ this.state.tokens=this.state.tokens.filter(x=>x.id!==this.local.selectedTokenId); this.local.selectedTokenId=null; this.updateTokenUI(); this.renderTokens(); }

    // --- NOTES & FILES ---
    saveNotes() { this.state.notes = document.getElementById('notes-area').value; }
    addNoteFile(file) {
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            this.state.attachments.push({ name: file.name, url: e.target.result });
            this.renderNotes();
        };
        reader.readAsDataURL(file);
    }
    renderNotes() {
        const l = document.getElementById('file-list'); l.innerHTML = "";
        this.state.attachments.forEach((a, idx) => {
            const d = document.createElement('div'); d.className = 'file-item';
            d.innerHTML = `<a href="${a.url}" download="${a.name}" style="color:#ccc;text-decoration:none;"><i class="fas fa-file"></i> ${a.name}</a> <button class="btn-xs delete" onclick="vtt.remNoteFile(${idx})">X</button>`;
            l.appendChild(d);
        });
    }
    remNoteFile(i) { this.state.attachments.splice(i, 1); this.renderNotes(); }

    // --- INITIATIVE ---
    addInitiative() { const n=document.getElementById('init-name').value||"Unit"; const v=parseInt(document.getElementById('init-val').value)||0; this.state.initiative.push({name:n,val:v}); this.renderInit(); }
    sortInitiative() { this.state.initiative.sort((a,b)=>b.val-a.val); this.renderInit(); }
    clearInitiative() { this.state.initiative=[]; this.state.initIndex=-1; this.renderInit(); }
    nextTurn() { if(!this.state.initiative.length)return; this.state.initIndex++; if(this.state.initIndex>=this.state.initiative.length)this.state.initIndex=0; this.renderInit(); }
    renderInit() {
        const l=document.getElementById('init-list'); l.innerHTML="";
        this.state.initiative.forEach((i,idx)=>{
            const d=document.createElement('div'); d.className='init-item';
            if(idx===this.state.initIndex) d.classList.add('active-turn');
            d.innerHTML=`<span>${i.name}</span><span class="init-badge">${i.val}</span><button class="btn-xs delete" onclick="vtt.remInit(${idx})">X</button>`;
            l.appendChild(d);
        });
    }
    remInit(i){this.state.initiative.splice(i,1); this.renderInit();}

    // --- SAVE/LOAD ---
    saveSession() { try{localStorage.setItem('lux_vtt_save', JSON.stringify(this.state)); alert("Salvo!");}catch(e){alert("Mapa muito grande para salvar no navegador.");} }
    loadSessionFromBrowser() { const d=localStorage.getItem('lux_vtt_save'); if(d && confirm("Restaurar sessão?")) this.loadData(JSON.parse(d)); }
    exportSession() { const a=document.createElement('a'); a.href="data:text/json;charset=utf-8,"+encodeURIComponent(JSON.stringify(this.state)); a.download="lux_session.json"; a.click(); }
    loadData(d) {
        this.state=d; 
        if(this.state.mapSrc){const i=new Image(); i.onload=()=>{this.state.mapImg=i;}; i.src=this.state.mapSrc;}
        this.state.tokens.forEach(t=>{if(t.imgSrc){const i=new Image(); i.src=t.imgSrc; t.img=i;}});
        document.getElementById('notes-area').value = this.state.notes || "";
        this.renderTokens(); this.renderInit(); this.renderNotes();
    }

    // --- EXTRAS ---
    toggleFX(k){const e=document.getElementById(k==='rain'?'fx-rain':'fx-vignette'); if(e)e.classList.toggle('hidden');}
    toggleGrid(){this.state.gridVisible=!this.state.gridVisible;}
    toggleFogVis(){this.state.fog.enabled=!this.state.fog.enabled;}
    updateVignetteOpacity(){document.getElementById('fx-vignette').style.opacity=document.getElementById('vig-intensity').value;}
    updateVolume(){this.local.volume=document.getElementById('global-volume').value;}
    addSound(file) { if(!file)return; const u=URL.createObjectURL(file); const d=document.createElement('div'); d.className='sound-btn'; d.innerText=file.name; d.onclick=()=>{const a=new Audio(u); a.volume=this.local.volume; a.play();}; d.oncontextmenu=(e)=>{e.preventDefault();d.remove();}; document.getElementById('sound-list').appendChild(d); }
    openTab(id, btn){ document.querySelectorAll('.sidebar-content').forEach(e=>e.classList.remove('active')); document.getElementById('tab-'+id).classList.add('active'); document.querySelectorAll('.sidebar-tabs button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
    roll(d){this.processRoll(d);} rollCustom(){this.processRoll(document.getElementById('custom-formula').value);}
    processRoll(s){try{const m=s.toLowerCase().match(/(\d+)d(\d+)([+-]\d+)?/);if(!m)return;const n=parseInt(m[1]),f=parseInt(m[2]),mod=parseInt(m[3])||0;let r=[],t=0;for(let i=0;i<n;i++){let v=Math.floor(Math.random()*f)+1;r.push(v);t+=v;}document.getElementById('dice-log').innerHTML=`<div class="roll-entry"><b>${s}</b>: [${r}] ${mod? (mod>0?'+'+mod:mod):''} = <span class="roll-res">${t+mod}</span></div>`+document.getElementById('dice-log').innerHTML;}catch(e){}}
    clearLog(){document.getElementById('dice-log').innerHTML="";}
    clearDrawings(){this.state.drawings=[];}
}

const vtt = new LuxVTT();