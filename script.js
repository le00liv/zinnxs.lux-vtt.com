class LuxVTT {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // Camada de Sombra (Essencial)
        this.shadowCanvas = document.createElement('canvas');
        this.shadowCtx = this.shadowCanvas.getContext('2d');

        this.channel = new BroadcastChannel('lux_vtt_channel');

        this.state = {
            mapImg: null, mapSrc: null, 
            tokens: [], 
            walls: [], drawings: [], 
            initiative: [], initIndex: -1, // Iniciativa
            gridSize: 50, pan: { x: 0, y: 0 }, scale: 1,
            ambientLight: 0.95, sync: false,
            gridVisible: true, wallsVisibleGM: true
        };

        this.local = {
            tool: 'pan',
            drag: { active: false, start: {x:0,y:0}, curr: {x:0,y:0}, last: {x:0,y:0} },
            selectedTokenId: null,
            brushSize: 5, tempWall: null, tempTokenFile: null
        };
    }

    init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.setupInputs();
        this.setupMouse();
        this.loadSessionFromBrowser();
        const loop = () => { this.draw(); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
        setInterval(() => { if(this.state.sync) this.broadcast(); }, 100);
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.shadowCanvas.width = window.innerWidth;
        this.shadowCanvas.height = window.innerHeight;
    }

    // --- RENDERIZAÇÃO ---
    draw() {
        const ctx = this.ctx;
        ctx.fillStyle = "#111"; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();
        ctx.translate(this.state.pan.x, this.state.pan.y);
        ctx.scale(this.state.scale, this.state.scale);

        // 1. Mapa
        if (this.state.mapImg) ctx.drawImage(this.state.mapImg, 0, 0);
        else {
            ctx.strokeStyle = "#333"; ctx.lineWidth = 5; ctx.strokeRect(0,0, 1920, 1080);
            ctx.fillStyle = "#222"; ctx.font = "40px sans-serif"; ctx.textAlign = "center"; ctx.fillText("Arraste um Mapa", 960, 540);
        }

        // 2. Grid
        if(this.state.gridVisible) this.drawGrid(ctx);

        // 3. Desenhos
        ctx.lineCap='round'; ctx.lineJoin='round';
        this.state.drawings.forEach(d => {
            ctx.beginPath(); ctx.strokeStyle = d.tool==='eraser'?"#000":d.color; ctx.lineWidth = d.width;
            if(d.path.length > 0) { ctx.moveTo(d.path[0].x, d.path[0].y); d.path.forEach(p => ctx.lineTo(p.x, p.y)); ctx.stroke(); }
        });

        // 4. Tokens SEM LUZ
        const unlitTokens = this.state.tokens.filter(t => (!t.lightRadius || t.lightRadius <= 0) && t.visible);
        unlitTokens.forEach(t => this.drawTokenBody(ctx, t));

        // 5. SOMBRA E LUZ
        this.drawLighting(ctx);

        // 6. Tokens COM LUZ
        const litTokens = this.state.tokens.filter(t => t.lightRadius > 0 && t.visible);
        litTokens.forEach(t => this.drawTokenBody(ctx, t));

        // 7. UI Mestre
        this.drawGMOverlay(ctx);

        ctx.restore();
    }

    drawTokenBody(ctx, t) {
        const s = t.size * this.state.gridSize;
        ctx.save();
        ctx.translate(t.x + s/2, t.y + s/2);

        // Seleção e Seta
        if(t.id === this.local.selectedTokenId) {
            ctx.shadowColor = "#06b6d4"; ctx.shadowBlur = 10;
            ctx.strokeStyle = "#06b6d4"; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(0,0, s/2 + 2, 0, Math.PI*2); ctx.stroke();
            
            // Seta de direção (sempre visível na seleção)
            ctx.save();
            ctx.rotate((t.rotation * Math.PI) / 180);
            ctx.fillStyle = "#fbbf24";
            ctx.beginPath(); ctx.moveTo(s/2+5, 0); ctx.lineTo(s/2+15, -5); ctx.lineTo(s/2+15, 5); ctx.fill();
            ctx.restore();
            
            ctx.shadowBlur = 0;
        }
        
        ctx.beginPath(); ctx.arc(0,0, s/2, 0, Math.PI*2); ctx.clip();
        if(t.img) { try { ctx.drawImage(t.img, -s/2, -s/2, s, s); } catch(e){} } 
        else {
            ctx.fillStyle = "#3b82f6"; ctx.fillRect(-s/2, -s/2, s, s);
            ctx.fillStyle = "#fff"; ctx.font = "bold 16px monospace"; 
            ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(t.name.substring(0,2).toUpperCase(), 0, 0);
        }
        ctx.restore();
    }

    drawLighting(ctx) {
        const sCtx = this.shadowCtx;
        sCtx.clearRect(0, 0, this.shadowCanvas.width, this.shadowCanvas.height);
        
        // Fundo Preto
        sCtx.save();
        sCtx.fillStyle = `rgba(0, 0, 0, ${this.state.ambientLight})`;
        sCtx.fillRect(0, 0, this.shadowCanvas.width, this.shadowCanvas.height);
        
        // Modo Recorte
        sCtx.globalCompositeOperation = 'destination-out';
        sCtx.translate(this.state.pan.x, this.state.pan.y);
        sCtx.scale(this.state.scale, this.state.scale);

        const allWalls = [...this.state.walls];

        this.state.tokens.forEach(t => {
            if(!t.lightRadius || t.lightRadius <= 0 || !t.visible) return;
            const lx = t.x + (t.size*this.state.gridSize)/2;
            const ly = t.y + (t.size*this.state.gridSize)/2;
            const radius = t.lightRadius * this.state.gridSize;

            const poly = this.computeVisibility(lx, ly, radius, allWalls, t.lightType, t.rotation);

            sCtx.beginPath();
            if(poly.length > 0) {
                sCtx.moveTo(poly[0].x, poly[0].y);
                poly.forEach(p => sCtx.lineTo(p.x, p.y));
            }
            sCtx.fill();
            sCtx.beginPath(); sCtx.arc(lx, ly, t.size*10, 0, Math.PI*2); sCtx.fill();
        });
        sCtx.restore();

        // Desenha Sombra
        ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(this.shadowCanvas, 0, 0); ctx.restore();

        // Brilho Colorido
        ctx.save(); ctx.globalCompositeOperation = 'source-over';
        this.state.tokens.forEach(t => {
            if(!t.lightRadius || t.lightRadius <= 0 || !t.visible) return;
            const lx = t.x + (t.size*this.state.gridSize)/2;
            const ly = t.y + (t.size*this.state.gridSize)/2;
            const radius = t.lightRadius * this.state.gridSize;

            const poly = this.computeVisibility(lx, ly, radius, allWalls, t.lightType, t.rotation);

            const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, radius);
            g.addColorStop(0, "rgba(255, 220, 150, 0.25)");
            g.addColorStop(1, "rgba(0, 0, 0, 0)");
            ctx.fillStyle = g;
            
            ctx.beginPath();
            if(poly.length > 0) {
                ctx.moveTo(poly[0].x, poly[0].y);
                poly.forEach(p => ctx.lineTo(p.x, p.y));
            }
            ctx.fill();
        });
        ctx.restore();
    }

    drawGMOverlay(ctx) {
        if(this.state.wallsVisibleGM) {
            ctx.lineWidth = 3; ctx.strokeStyle = "#ef4444"; ctx.beginPath();
            this.state.walls.forEach(w => { ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); }); ctx.stroke();
            ctx.fillStyle = "#fff"; this.state.walls.forEach(w => { ctx.beginPath(); ctx.arc(w.x1, w.y1, 4, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(w.x2, w.y2, 4, 0, Math.PI*2); ctx.fill(); });
        }
        if(this.local.tool === 'wall' && this.local.drag.active && this.local.tempWall) {
            ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2; ctx.setLineDash([5,5]);
            ctx.beginPath(); ctx.moveTo(this.local.tempWall.x1, this.local.tempWall.y1); ctx.lineTo(this.local.tempWall.x2, this.local.tempWall.y2); ctx.stroke(); ctx.setLineDash([]);
        }
        if((this.local.tool==='draw'||this.local.tool==='eraser') && this.local.drag.active && this.local.currentPath){
            ctx.beginPath(); ctx.strokeStyle = this.local.tool==='eraser'?"#fff":document.getElementById('brush-color').value; ctx.lineWidth = this.local.brushSize;
            ctx.moveTo(this.local.currentPath[0].x, this.local.currentPath[0].y); this.local.currentPath.forEach(p=>ctx.lineTo(p.x, p.y)); ctx.stroke();
        }
    }

    drawGrid(ctx) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)"; ctx.lineWidth = 1; ctx.beginPath();
        const startX = Math.floor(-this.state.pan.x / this.state.scale / this.state.gridSize) * this.state.gridSize;
        const endX = startX + (this.canvas.width / this.state.scale) + this.state.gridSize;
        const startY = Math.floor(-this.state.pan.y / this.state.scale / this.state.gridSize) * this.state.gridSize;
        const endY = startY + (this.canvas.height / this.state.scale) + this.state.gridSize;
        for(let x=startX; x<endX; x+=this.state.gridSize) { ctx.moveTo(x, startY); ctx.lineTo(x, endY); }
        for(let y=startY; y<endY; y+=this.state.gridSize) { ctx.moveTo(startX, y); ctx.lineTo(endX, y); }
        ctx.stroke();
    }

    // --- CORREÇÃO DO CÍRCULO INCOMPLETO (PACMAN) ---
    computeVisibility(lx, ly, radius, walls, type = 'circle', rotation = 0) {
        const box = { x1: lx-radius, y1: ly-radius, x2: lx+radius, y2: ly+radius };
        const nearby = walls.filter(w => !(w.x1 > box.x2 || w.x2 < box.x1 || w.y1 > box.y2 || w.y2 < box.y1));
        
        let points = [];
        nearby.forEach(w => { points.push({x: w.x1, y: w.y1}); points.push({x: w.x2, y: w.y2}); });
        
        // ADICIONA CANTOS DA BOUNDING BOX PARA AJUDAR
        points.push({x: box.x1, y: box.y1}, {x: box.x2, y: box.y1}, {x: box.x2, y: box.y2}, {x: box.x1, y: box.y2});

        // Configurações do Cone
        let minAngle = -Math.PI;
        let maxAngle = Math.PI;
        
        if (type === 'cone') {
            const rotRad = (rotation * Math.PI) / 180;
            const spread = (60 * Math.PI) / 180;
            minAngle = rotRad - spread/2;
            maxAngle = rotRad + spread/2;
        }

        let unique = [];
        points.forEach(p => { if(!unique.some(up => Math.hypot(up.x-p.x, up.y-p.y) < 1)) unique.push(p); });

        let angles = [];
        
        if(type === 'cone') {
            angles.push(minAngle, maxAngle);
        } else {
            // CORREÇÃO CRÍTICA: Se for círculo, adiciona ângulos cardeais para fechar o "pacman"
            // Isso força o algoritmo a lançar raios em todas as direções principais
            angles.push(0, Math.PI, -Math.PI, Math.PI/2, -Math.PI/2);
        }

        unique.forEach(p => { 
            const angle = Math.atan2(p.y - ly, p.x - lx);
            if (type === 'circle') {
                angles.push(angle - 0.0001, angle, angle + 0.0001); 
            } else {
                let diff = angle - (rotation * Math.PI / 180);
                while(diff <= -Math.PI) diff += 2*Math.PI;
                while(diff > Math.PI) diff -= 2*Math.PI;
                if(Math.abs(diff) <= (60 * Math.PI / 180) / 2) {
                    angles.push(angle - 0.0001, angle, angle + 0.0001);
                }
            }
        });

        angles.sort((a,b) => a-b);

        let intersections = [];
        // O início do polígono deve ser o centro (para cones ficarem bonitos)
        intersections.push({x: lx, y: ly});

        angles.forEach(angle => {
            const dx = Math.cos(angle); const dy = Math.sin(angle);
            const ray = { x1: lx, y1: ly, x2: lx + dx * radius, y2: ly + dy * radius };
            let closest = { t: 1, x: ray.x2, y: ray.y2 };
            nearby.forEach(w => { const intersect = this.getIntersection(ray, w); if(intersect && intersect.t < closest.t) closest = intersect; });
            intersections.push({ x: closest.x, y: closest.y });
        });
        
        return intersections;
    }

    getIntersection(r, s) {
        const r_dx = r.x2 - r.x1; const r_dy = r.y2 - r.y1;
        const s_dx = s.x2 - s.x1; const s_dy = s.y2 - s.y1;
        const d = r_dx * s_dy - r_dy * s_dx;
        if(d === 0) return null;
        const t = ((s.x1 - r.x1) * s_dy - (s.y1 - r.y1) * s_dx) / d;
        const u = ((s.x1 - r.x1) * r_dy - (s.y1 - r.y1) * r_dx) / d;
        if(t >= 0 && t <= 1 && u >= 0 && u <= 1) return { x: r.x1 + t * r_dx, y: r.y1 + t * r_dy, t: t };
        return null;
    }

    // --- CONTROLES MOUSE ---
    setupMouse() {
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault(); const d = e.deltaY < 0 ? 1 : -1; const f = 1 + (d * 0.1);
            const ns = Math.min(Math.max(0.1, this.state.scale * f), 5); const rf = ns / this.state.scale;
            this.state.pan.x -= (e.clientX - this.state.pan.x) * (rf - 1);
            this.state.pan.y -= (e.clientY - this.state.pan.y) * (rf - 1);
            this.state.scale = ns;
        });
        this.canvas.addEventListener('mousedown', e => {
            if(e.button === 1) this.local.tool = 'pan-temp';
            this.local.drag.active = true; this.local.drag.last = {x:e.clientX, y:e.clientY}; this.local.drag.start = {x:e.clientX, y:e.clientY};
            const w = this.getMouse({x:e.clientX, y:e.clientY});
            if(this.local.tool === 'wall') this.local.tempWall = {x1:w.x, y1:w.y, x2:w.x, y2:w.y};
            else if (this.local.tool === 'select') {
                const t = [...this.state.tokens].reverse().find(x => Math.hypot(x.x+(x.size*this.state.gridSize)/2 - w.x, x.y+(x.size*this.state.gridSize)/2 - w.y) < (x.size*this.state.gridSize)/2);
                this.local.selectedTokenId = t ? t.id : null; this.updateTokenUI();
            } else if(this.local.tool.match(/draw|eraser/)) this.local.currentPath = [w];
        });
        this.canvas.addEventListener('mousemove', e => {
            if(!this.local.drag.active) return;
            const dx = e.clientX - this.local.drag.last.x; const dy = e.clientY - this.local.drag.last.y;
            this.local.drag.last = {x:e.clientX, y:e.clientY}; const w = this.getMouse({x:e.clientX, y:e.clientY});
            if(this.local.tool.includes('pan')) { this.state.pan.x += dx; this.state.pan.y += dy; }
            else if(this.local.tool === 'wall' && this.local.tempWall) { this.local.tempWall.x2 = w.x; this.local.tempWall.y2 = w.y; }
            else if (this.local.tool === 'select' && this.local.selectedTokenId) { const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t){t.x+=dx/this.state.scale; t.y+=dy/this.state.scale;} }
            else if(this.local.tool.match(/draw|eraser/)) this.local.currentPath.push(w);
        });
        this.canvas.addEventListener('mouseup', e => {
            if(this.local.tool === 'wall' && this.local.tempWall) { this.state.walls.push(this.local.tempWall); this.local.tempWall = null; }
            if(this.local.tool.match(/draw|eraser/) && this.local.currentPath) { this.state.drawings.push({path:[...this.local.currentPath], color:document.getElementById('brush-color').value, tool:this.local.tool, width:this.local.brushSize}); this.local.currentPath=null; }
            if(this.local.tool === 'pan-temp') this.local.tool = 'select';
            this.local.drag.active = false;
        });
    }

    setTool(t) { this.local.tool = t; document.querySelectorAll('.btn-hud').forEach(b => b.classList.remove('active')); const m={'pan':'btn-pan','select':'btn-select','ruler':'btn-ruler','draw':'btn-draw','eraser':'btn-eraser','wall':'btn-wall'}; if(m[t]) document.getElementById(m[t]).classList.add('active'); this.canvas.style.cursor = t==='pan'?'grab':t==='select'?'default':'crosshair'; }
    getMouse(p) { return { x: (p.x - this.state.pan.x)/this.state.scale, y: (p.y - this.state.pan.y)/this.state.scale }; }
    setupInputs() {
        document.getElementById('map-upload').onchange = e => { const f=e.target.files[0]; if(f){const r=new FileReader(); r.onload=ev=>{const i=new Image(); i.onload=()=>{this.state.mapImg=i; this.state.mapSrc=ev.target.result;}; i.src=ev.target.result;}; r.readAsDataURL(f);} };
        document.getElementById('token-upload').onchange = e => this.local.tempTokenFile = e.target.files[0];
    }

    // --- TOKENS & INICIATIVA ---
    addToken() {
        const n = document.getElementById('new-token-name').value || "Token";
        const cx = (this.canvas.width/2 - this.state.pan.x)/this.state.scale;
        const cy = (this.canvas.height/2 - this.state.pan.y)/this.state.scale;
        const t = { id: Date.now(), name: n, x: cx, y: cy, size: 1, lightRadius: 0, lightType: 'circle', rotation: 0, visible: true, imgSrc: null, img: null };
        if(this.local.tempTokenFile) {
            const r = new FileReader();
            r.onload = ev => { t.imgSrc = ev.target.result; const i = new Image(); i.onload=()=>{t.img=i; this.renderTokenList();}; i.src=t.imgSrc; this.local.tempTokenFile=null; document.getElementById('token-upload').value=""; };
            r.readAsDataURL(this.local.tempTokenFile);
        }
        this.state.tokens.push(t); this.renderTokenList();
    }

    renderTokenList() {
        const l = document.getElementById('token-list'); l.innerHTML = "";
        this.state.tokens.forEach(t => {
            const d = document.createElement('div'); d.className = 'token-item';
            const eyeIcon = t.visible ? 'fa-eye' : 'fa-eye-slash';
            const eyeClass = t.visible ? '' : 'hidden-token';
            
            d.innerHTML = `
                <div style="flex:1" onclick="vtt.selectTokenFromList(${t.id})">
                    <span>${t.name}</span> <small>${t.lightType === 'cone' ? '🔦' : '💡'} ${t.lightRadius}m</small>
                </div>
                <button class="eye-btn ${eyeClass}" onclick="vtt.toggleTokenVis(${t.id})"><i class="fas ${eyeIcon}"></i></button>
            `;
            l.appendChild(d);
        });
    }

    selectTokenFromList(id) { this.local.selectedTokenId = id; this.local.tool='select'; this.updateTokenUI(); }
    toggleTokenVis(id) { const t=this.state.tokens.find(x=>x.id===id); if(t){ t.visible=!t.visible; this.renderTokenList(); } }

    addInitiative() {
        const n = document.getElementById('init-name').value || "Unit";
        const v = parseInt(document.getElementById('init-val').value) || 0;
        this.state.initiative.push({name:n, val:v});
        this.renderInit();
    }
    sortInitiative() { this.state.initiative.sort((a,b) => b.val - a.val); this.renderInit(); }
    clearInitiative() { this.state.initiative = []; this.state.initIndex = -1; this.renderInit(); }
    nextTurn() { if(this.state.initiative.length===0)return; this.state.initIndex++; if(this.state.initIndex >= this.state.initiative.length) this.state.initIndex=0; this.renderInit(); }
    
    renderInit() {
        const l = document.getElementById('init-list'); l.innerHTML = "";
        this.state.initiative.forEach((i, idx) => {
            const d = document.createElement('div'); d.className = 'init-item';
            if(idx === this.state.initIndex) d.classList.add('active-turn');
            d.innerHTML = `<span>${i.name}</span> <span class="init-val">${i.val}</span>`;
            
            // Botão de deletar item específico
            const btn = document.createElement('button');
            btn.className = "delete-btn"; btn.style.width="auto"; btn.style.padding="2px 5px"; btn.style.marginLeft="10px";
            btn.innerHTML = "X";
            btn.onclick = () => { this.state.initiative.splice(idx,1); this.renderInit(); };
            d.appendChild(btn);
            
            l.appendChild(d);
        });
    }

    updateTokenUI() {
        const t = this.state.tokens.find(x => x.id === this.local.selectedTokenId);
        if(t) {
            document.getElementById('token-controls').classList.remove('hidden');
            document.getElementById('sel-token-name').innerText = t.name;
            document.getElementById('light-slider').value = t.lightRadius;
            document.getElementById('light-val').innerText = t.lightRadius + "m";
            document.getElementById('light-type').value = t.lightType || 'circle';
            document.getElementById('light-rotation').value = t.rotation || 0;
        } else {
            document.getElementById('token-controls').classList.add('hidden');
        }
    }

    updateTokenData(key, val) {
        const t = this.state.tokens.find(x => x.id === this.local.selectedTokenId);
        if(t) { 
            t[key] = (key==='lightType') ? val : parseInt(val); 
            if(key === 'lightRadius') document.getElementById('light-val').innerText = val+"m";
            this.renderTokenList(); 
        }
    }

    resizeToken(d) { const t=this.state.tokens.find(x=>x.id===this.local.selectedTokenId); if(t) t.size=Math.max(0.5, t.size+d); }
    deleteToken() { this.state.tokens=this.state.tokens.filter(x=>x.id!==this.local.selectedTokenId); this.local.selectedTokenId=null; this.updateTokenUI(); this.renderTokenList(); }
    clearDrawings() { if(confirm("Apagar desenhos?")) this.state.drawings=[]; }
    clearWalls() { if(confirm("Apagar paredes?")) this.state.walls=[]; }
    undoLastWall() { this.state.walls.pop(); }
    toggleSync() { this.state.sync = document.getElementById('sync-toggle').checked; }
    toggleGrid() { this.state.gridVisible = !this.state.gridVisible; }
    toggleWallsVis() { this.state.wallsVisibleGM = !this.state.wallsVisibleGM; }
    setAmbientLight(v) { this.state.ambientLight = parseFloat(v); }
    openTab(id, btn) { document.querySelectorAll('.sidebar-content').forEach(e=>e.classList.remove('active')); document.getElementById('tab-'+id).classList.add('active'); document.querySelectorAll('.sidebar-tabs button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
    roll(f) { const r = Math.floor(Math.random()*parseInt(f.split('d')[1]))+1; const l = document.getElementById('dice-log'); l.innerHTML = `<div class="log-entry"><strong>${f}</strong>: ${r}</div>` + l.innerHTML; }
    rollCustom() { this.roll(document.getElementById('custom-formula').value||'1d20'); }
    saveSession() { localStorage.setItem('lux_vtt_save', JSON.stringify(this.state)); alert("Salvo!"); }
    loadSessionFromBrowser() { const d=localStorage.getItem('lux_vtt_save'); if(d && confirm("Restaurar?")) { const ld=JSON.parse(d); Object.assign(this.state, ld); if(this.state.mapSrc){const i=new Image(); i.src=this.state.mapSrc; this.state.mapImg=i;} this.renderTokenList(); }}

    openPlayerScreen() {
        const raycastLogic = `
        function getIntersection(r, s) {const r_dx=r.x2-r.x1;const r_dy=r.y2-r.y1;const s_dx=s.x2-s.x1;const s_dy=s.y2-s.y1;const d=r_dx*s_dy-r_dy*s_dx;if(d===0)return null;const t=((s.x1-r.x1)*s_dy-(s.y1-r.y1)*s_dx)/d;const u=((s.x1-r.x1)*r_dy-(s.y1-r.y1)*r_dx)/d;if(t>=0&&t<=1&&u>=0&&u<=1)return{x:r.x1+t*r_dx,y:r.y1+t*r_dy,t:t};return null;}
        function compute(lx,ly,radius,walls,type='circle',rot=0){
            const box={x1:lx-radius,y1:ly-radius,x2:lx+radius,y2:ly+radius};
            const nearby=walls.filter(w=>!(w.x1>box.x2||w.x2<box.x1||w.y1>box.y2||w.y2<box.y1));
            let points=[]; nearby.forEach(w=>{points.push({x:w.x1,y:w.y1},{x:w.x2,y:w.y2})});
            points.push({x:box.x1,y:box.y1},{x:box.x2,y:box.y1},{x:box.x2,y:box.y2},{x:box.x1,y:box.y2});
            let unique=[]; points.forEach(p=>{if(!unique.some(u=>Math.hypot(u.x-p.x,u.y-p.y)<1))unique.push(p)});
            let angles=[];
            if(type==='cone'){ const rad=rot*Math.PI/180; const spread=60*Math.PI/180; angles.push(rad-spread/2, rad+spread/2); }
            else { angles.push(0, Math.PI, -Math.PI, Math.PI/2, -Math.PI/2); }
            unique.forEach(p=>{
                const a=Math.atan2(p.y-ly,p.x-lx);
                if(type==='circle') angles.push(a-0.0001, a, a+0.0001);
                else {
                    let diff=a-(rot*Math.PI/180); while(diff<=-Math.PI)diff+=2*Math.PI; while(diff>Math.PI)diff-=2*Math.PI;
                    if(Math.abs(diff)<=(60*Math.PI/180)/2) angles.push(a-0.0001, a, a+0.0001);
                }
            });
            angles.sort((a,b)=>a-b);
            let poly=[{x:lx,y:ly}];
            angles.forEach(a=>{
                const dx=Math.cos(a);const dy=Math.sin(a);
                const ray={x1:lx,y1:ly,x2:lx+dx*radius,y2:ly+dy*radius};
                let closest={t:1,x:ray.x2,y:ray.y2};
                nearby.forEach(w=>{const i=getIntersection(ray,w); if(i&&i.t<closest.t)closest=i;});
                poly.push({x:closest.x,y:closest.y});
            });
            return poly;
        }`;

        const html = `<!DOCTYPE html><html><head><title>Lux Player</title><style>body{margin:0;background:#000;overflow:hidden;}canvas{display:block;}</style></head><body><canvas id="c"></canvas><script>
            const c=document.getElementById('c'); const ctx=c.getContext('2d');
            const sCanvas=document.createElement('canvas'); const sCtx=sCanvas.getContext('2d');
            const ch=new BroadcastChannel('lux_vtt_channel');
            let state=null; let mapImg=null; let tokenImgs={};
            function resize(){c.width=window.innerWidth;c.height=window.innerHeight;sCanvas.width=c.width;sCanvas.height=c.height;}
            window.onresize=resize; resize();
            ch.onmessage=(e)=>{if(e.data.type==='state'){state=e.data.payload;if(state.mapSrc&&(!mapImg||mapImg.src!==state.mapSrc)){mapImg=new Image();mapImg.src=state.mapSrc;}}};
            ${raycastLogic}
            function drawToken(t){const s=t.size*state.gridSize;ctx.save();ctx.translate(t.x+s/2,t.y+s/2);ctx.beginPath();ctx.arc(0,0,s/2,0,Math.PI*2);ctx.clip();if(t.imgSrc){if(!tokenImgs[t.id]){tokenImgs[t.id]=new Image();tokenImgs[t.id].src=t.imgSrc;}if(tokenImgs[t.id].complete)ctx.drawImage(tokenImgs[t.id],-s/2,-s/2,s,s);}else{ctx.fillStyle="#3b82f6";ctx.fillRect(-s/2,-s/2,s,s);}ctx.restore();}
            function loop(){
                requestAnimationFrame(loop); ctx.fillStyle="#000"; ctx.fillRect(0,0,c.width,c.height); if(!state)return;
                ctx.save(); ctx.translate(state.pan.x,state.pan.y); ctx.scale(state.scale,state.scale);
                if(mapImg)ctx.drawImage(mapImg,0,0);
                if(state.gridVisible){ctx.strokeStyle="rgba(255,255,255,0.1)";ctx.lineWidth=1;ctx.beginPath();const sx=Math.floor(-state.pan.x/state.scale/state.gridSize)*state.gridSize;const ex=sx+(c.width/state.scale)+state.gridSize;const sy=Math.floor(-state.pan.y/state.scale/state.gridSize)*state.gridSize;const ey=sy+(c.height/state.scale)+state.gridSize;for(let x=sx;x<ex;x+=state.gridSize){ctx.moveTo(x,sy);ctx.lineTo(x,ey);}for(let y=sy;y<ey;y+=state.gridSize){ctx.moveTo(sx,y);ctx.lineTo(ex,y);}ctx.stroke();}
                state.drawings.forEach(d=>{ctx.beginPath();ctx.strokeStyle=d.color;ctx.lineWidth=d.width;if(d.path.length>0){ctx.moveTo(d.path[0].x,d.path[0].y);d.path.forEach(p=>ctx.lineTo(p.x,p.y));ctx.stroke();}});
                const unlit=state.tokens.filter(t=>(!t.lightRadius||t.lightRadius<=0)&&t.visible); unlit.forEach(drawToken);

                // SHADOW LAYER
                sCtx.clearRect(0,0,sCanvas.width,sCanvas.height); sCtx.save(); sCtx.fillStyle="rgba(0,0,0,"+state.ambientLight+")"; sCtx.fillRect(0,0,sCanvas.width,sCanvas.height);
                sCtx.globalCompositeOperation='destination-out'; sCtx.translate(state.pan.x,state.pan.y); sCtx.scale(state.scale,state.scale);
                state.tokens.forEach(t=>{if(!t.lightRadius||t.lightRadius<=0||!t.visible)return;const s=t.size*state.gridSize;const lx=t.x+s/2;const ly=t.y+s/2;const poly=compute(lx,ly,t.lightRadius*state.gridSize,state.walls||[],t.lightType,t.rotation);sCtx.beginPath();if(poly.length>0){sCtx.moveTo(poly[0].x,poly[0].y);poly.forEach(p=>sCtx.lineTo(p.x,p.y));}sCtx.fill();sCtx.beginPath();sCtx.arc(lx,ly,s*10,0,Math.PI*2);sCtx.fill();});
                sCtx.restore(); ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(sCanvas,0,0); ctx.restore();

                // LIGHT GLOW
                ctx.save(); ctx.globalCompositeOperation='source-over';
                state.tokens.forEach(t=>{if(!t.lightRadius||t.lightRadius<=0||!t.visible)return;const s=t.size*state.gridSize;const lx=t.x+s/2;const ly=t.y+s/2;const r=t.lightRadius*state.gridSize;const poly=compute(lx,ly,r,state.walls||[],t.lightType,t.rotation);const g=ctx.createRadialGradient(lx,ly,0,lx,ly,r);g.addColorStop(0,"rgba(255,220,160,0.25)");g.addColorStop(1,"rgba(0,0,0,0)");ctx.fillStyle=g;ctx.beginPath();if(poly.length>0){ctx.moveTo(poly[0].x,poly[0].y);poly.forEach(p=>ctx.lineTo(p.x,p.y));}ctx.fill();});
                ctx.restore();

                const lit=state.tokens.filter(t=>t.lightRadius>0&&t.visible); lit.forEach(drawToken);
                ctx.restore();
            }
            loop();
        <\/script></body></html>`;
        const blob=new Blob([html],{type:'text/html'}); window.open(URL.createObjectURL(blob),"LuxPlayer","width=800,height=600");
    }

    broadcast() { const p=JSON.parse(JSON.stringify(this.state)); p.tokens.forEach(t=>delete t.img); delete p.mapImg; this.channel.postMessage({type:'state',payload:p}); }
}

window.onload=()=>{try{window.vtt=new LuxVTT(); window.vtt.init(); console.log("System Ready");}catch(e){alert(e.message);}};