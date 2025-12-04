// ================= CONFIGURATION & VARIABLES =================
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const syncRef = database.ref('session');

let player;
let queue = [];
let queueIndex = 0;
let isDragging = false;
let myState = -1; // -1 unstarted, 1 playing, 2 paused, 3 buffering

// Core Master/Viewer Sync Variables
const deviceId = new Date().getTime();
const playerRef = database.ref('playerStatus/' + deviceId); // Unique reference for this device
let isMaster = false;
let masterId = null;

// UI elements (reusing lag variables for simple status updates)
let lagStartTime = null; 
let lagUpdateInterval; 

const dom = {
    overlay: document.getElementById('sync-blocker'),
    msg: document.getElementById('blocker-text'),
    disc: document.getElementById('music-disc'),
    art: document.querySelector('.vinyl-center'),
    title: document.getElementById('current-song-title'),
    playBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    search: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count'),
    // Get all buttons that non-master clients shouldn't use
    ctrlBtns: document.querySelectorAll('.btn-ctrl')
};

// ================= YOUTUBE SETUP =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: 'M7lc1UVf-VE',
        playerVars: { 
            'playsinline': 1, 
            'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function onPlayerReady() {
    listenForSync();
    // Start reporting my presence
    playerRef.onDisconnect().remove(); 
    playerRef.set({ id: deviceId, timestamp: firebase.database.ServerValue.TIMESTAMP });
    
    // Start sending heartbeat/status updates every 500ms
    setInterval(sendMasterStatus, 500); 
    setInterval(updateProgress, 500);
    
    // Clean up players who leave the session (15-minute interval)
    setInterval(removeStalePlayers, 900000); 
}

function onPlayerStateChange(e) {
    myState = e.data;
    if (e.data === 0) playNext(); // 0 = Ended
}

function updateFirebase(updates) {
    syncRef.update(updates);
}


// ================= MASTER/VIEWER SYNC LOGIC =================

// MASTER: Sends current time to Firebase
function sendMasterStatus() {
    if (!player || !isMaster || queue.length === 0) return;

    // Only update time if actively playing (State 1) or paused intentionally (State 2)
    const state = player.getPlayerState();
    if (state === 1 || state === 2) { 
        updateFirebase({ 
            seekTime: player.getCurrentTime(),
            status: state === 1 ? 'play' : 'pause',
        });
    }
}

// Controls the Master/Viewer role and updates the entire app state
function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        if (!data) {
            // If session is empty, I claim master role
            claimMasterRole();
            return;
        }

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        masterId = data.master;

        // Determine if I am the Master
        if (masterId === deviceId) {
            isMaster = true;
            enableControls(true);
        } else if (!masterId) {
            // If no master is defined, I claim the role
            claimMasterRole();
            return;
        } else {
            isMaster = false;
            enableControls(false);
        }

        renderQueueUI();
        
        // SYNC LOGIC (Applies to ALL players: Master and Viewers)
        syncPlayerState(data);
    });
}

// Function to claim the Master role
function claimMasterRole() {
    updateFirebase({ master: deviceId });
    console.log("[SYNC] Claiming Master Role.");
    isMaster = true;
    enableControls(true);
}

// Function to enable/disable controls based on role
function enableControls(isMaster) {
    dom.ctrlBtns.forEach(btn => {
        btn.disabled = !isMaster;
        btn.style.opacity = isMaster ? 1 : 0.5;
        btn.style.cursor = isMaster ? 'pointer' : 'not-allowed';
    });
    // Special handling for the search button (always allowed)
    document.getElementById('searchInput').disabled = false;
    document.getElementById('searchInput').style.opacity = 1;

    document.getElementById('resume-btn').style.display = isMaster ? 'block' : 'none';
}


// Function to apply the shared state to the local player
function syncPlayerState(data) {
    if (queue.length === 0) {
        dom.title.innerText = "Select a Song";
        dom.disc.style.animationPlayState = 'paused';
        return;
    }
    
    const song = queue[queueIndex];
    const serverTime = data.seekTime || 0;
    const serverStatus = data.status;

    // 1. Load the correct video
    if (player.getVideoData().video_id !== song.videoId) {
        player.loadVideoById(song.videoId);
        dom.title.innerText = song.title;
        dom.art.style.backgroundImage = `url('${song.thumbnail}')`;
    }

    // 2. Check for Ad/Lag ONLY if I am the Master
    if (isMaster) {
        checkMasterLag();
    } else {
        // VIEWERS: Just follow the master's time and status
        
        // Hide the shield for viewers
        dom.overlay.classList.remove('active');
        if (lagUpdateInterval) { clearInterval(lagUpdateInterval); lagUpdateInterval = null; }
        lagStartTime = null;

        // Force time sync
        if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
            player.seekTo(serverTime, true);
        }

        // Force play/pause
        if (serverStatus === 'play' && myState !== 1) {
            player.playVideo();
            dom.disc.style.animationPlayState = 'running';
        } else if (serverStatus === 'pause' && myState === 1) {
            player.pauseVideo();
            dom.disc.style.animationPlayState = 'paused';
        }
    }
    
    // Update play/pause button icon (Applies to all)
    if (serverStatus === 'play') {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    }
}


// ONLY RUNS ON MASTER PLAYER
function checkMasterLag() {
    // 1. Detect if the MASTER is stuck on an ad (State 3: Buffering)
    const isMasterStuck = player.getPlayerState() === 3; 

    if (isMasterStuck) {
        // 1. Start/Check Lag Timer
        if (lagStartTime === null) {
            lagStartTime = Date.now();
            if (!lagUpdateInterval) {
                 lagUpdateInterval = setInterval(updateLagUI, 1000);
            }
        }
        const timeElapsed = Date.now() - lagStartTime;
        const timeLimit = 120000; // 2 minutes (120 seconds)
        const secondsRemaining = Math.max(0, Math.floor((timeLimit - timeElapsed) / 1000));
        
        // 2. FORCE RESUME IF TIMEOUT EXCEEDED
        if (timeElapsed >= timeLimit) {
            console.log("[SYNC] Auto-resuming Master due to 2-minute timeout.");
            lagStartTime = null; 
            window.resumeSync();
            return;
        }

        // 3. APPLY SHIELD
        dom.overlay.classList.add('active');
        dom.msg.innerText = "AD DETECTED / BUFFERING";
        
        dom.disc.style.animationPlayState = 'paused';
        document.getElementById('sync-timer').innerText = secondsRemaining;

    } else {
        // No lag detected: Resume normal operation
        lagStartTime = null; 
        
        if (lagUpdateInterval) {
            clearInterval(lagUpdateInterval);
            lagUpdateInterval = null;
        }

        dom.overlay.classList.remove('active');
    }
}

// Only runs on the Master device
function removeStalePlayers() {
    if (!isMaster) return; 

    // We only remove players whose ID is NOT the current master ID
    const STALE_TIMEOUT_MS = 900000; // 15 minutes (15 * 60 * 1000)
    const cutoff = Date.now() - STALE_TIMEOUT_MS;

    database.ref('playerStatus').once('value', snapshot => {
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            const partnerId = childSnap.key;

            if (partnerId !== masterId && partnerData.timestamp < cutoff) {
                // DELETE the stale player node
                database.ref('playerStatus/' + partnerId).remove();
            }
        });
    });
}


// ================= CONTROLS & UI HELPERS =================

// Helper to update the lag status text
function updateLagUI() {
    if (lagStartTime) {
        const timeElapsed = Date.now() - lagStartTime;
        const secondsElapsed = Math.floor(timeElapsed / 1000);
        document.getElementById('lag-status').innerText = `Lag duration: ${secondsElapsed} seconds`;
    }
}

// Master's "Skip Ad" equivalent command
window.resumeSync = function() {
    if (!isMaster) return;

    if (lagUpdateInterval) {
        clearInterval(lagUpdateInterval);
        lagUpdateInterval = null;
    }
    lagStartTime = null;

    dom.overlay.classList.remove('active');
    
    // Forces the master player to play and pushes the new time/status to all Viewers
    player.playVideo(); 
    updateFirebase({ 
        status: 'play', 
        seekTime: player.getCurrentTime() || 0,
    });
}

function togglePlay() {
    if(!isMaster || queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;
    // Pushes the command to all Viewers
    updateFirebase({ 
        status: isPlaying ? 'pause' : 'play', 
        seekTime: player.getCurrentTime(),
    });
}

function syncSeek(seconds) {
    if(!isMaster) return;
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    // Pushes the command to all Viewers
    updateFirebase({ seekTime: newTime });
}

function playNext() {
    if(!isMaster) return;
    if (queueIndex < queue.length - 1) {
        updateFirebase({ queueIndex: queueIndex + 1, status: 'play', seekTime: 0 });
    } else {
        updateFirebase({ status: 'pause', seekTime: 0 });
    }
}

// ================= SEARCH & QUEUE (Non-Master functions always allowed) =================

dom.search.addEventListener('input', (e) => {
    const q = e.target.value;
    
    if (q.includes('youtu')) { 
        const id = q.split('v=')[1]?.split('&')[0] || q.split('/').pop();
        if(id) {
            addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        }
        return;
    }
    
    if (q.length > 2) {
        searchYouTube(q);
        switchTab('results');
    }
});

async function searchYouTube(q) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${q}&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    dom.resList.innerHTML = '';
    
    if (data.items.length === 0) {
        dom.resList.innerHTML = '<div class="empty-state">NO RESULTS FOUND</div>';
    }

    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        const safeTitle = item.snippet.title.replace(/'/g, "\\'");
        
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
            <div class="song-meta"><h4>${item.snippet.title}</h4></div>
            <i class="fa-solid fa-plus" style="padding:10px; color:#00cec9" onclick="addToQueue('${item.id.videoId}', '${safeTitle}', '${item.snippet.thumbnails.default.url}')"></i>
        `;
        dom.resList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    if (queue.length === 0) {
        updateFirebase({ queue: newQueue, queueIndex: 0, status: 'play', seekTime: 0 });
    } else {
        updateFirebase({ queue: newQueue });
    }
    dom.search.value = '';
    switchTab('queue');
}

function renderQueueUI() {
    dom.qCount.innerText = `(${queue.length})`;
    dom.qList.innerHTML = '';
    if (queue.length === 0) { dom.qList.innerHTML = '<div class="empty-state">QUEUE EMPTY</div>'; return; }
    
    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        if (idx === queueIndex) div.style.background = 'rgba(0, 255, 255, 0.1)';
        
        div.innerHTML = `
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-meta">
                <h4>${song.title}</h4>
                <p style="font-size:10px; color:#00cec9">${idx === queueIndex ? (isMaster ? 'MASTER PLAYING' : 'VIEWER PLAYING') : 'QUEUED'}</p>
            </div>
            <i class="fa-solid fa-xmark" style="padding:10px; color:#ff4757" onclick="window.deleteSong(event, ${idx})"></i>
        `;
        div.onclick = (e) => { 
            if(!isMaster) return; // Only Master can change song
            if(!e.target.classList.contains('fa-xmark')) {
                updateFirebase({ queueIndex: idx, status: 'play', seekTime: 0 });
            }
        };
        dom.qList.appendChild(div);
    });
}

window.deleteSong = function(e, idx) {
    if(!isMaster) return; // Only Master can delete
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = queueIndex;
    if (idx < queueIndex) newIdx--;
    updateFirebase({ queue: newQueue, queueIndex: newIdx < 0 ? 0 : newIdx });
}

window.clearQueue = function() {
    if(!isMaster) return; // Only Master can clear
    if(confirm("Clear Queue?")) updateFirebase({ queue: [], queueIndex: 0, status: 'pause' });
}

function switchTab(t) {
    document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.scroll-list').forEach(el => el.classList.remove('active-list'));
    if (t === 'results') {
        dom.resList.classList.add('active-list');
        document.querySelector('.tab:nth-child(1)').classList.add('active');
    } else {
        dom.qList.classList.add('active-list');
        document.querySelector('.tab:nth-child(2)').classList.add('active');
    }
}

// UI HELPERS (Always allowed)
dom.seekBar.addEventListener('change', () => {
    if(!isMaster) return; // Only Master can seek
    const time = (dom.seekBar.value / 100) * player.getDuration();
    syncSeek(time - player.getCurrentTime()); // Calculate difference for syncSeek
});
function updateProgress() {
    if (!player) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if(d) {
        dom.seekBar.value = (c / d) * 100;
        dom.curr.innerText = formatTime(c);
        dom.dur.innerText = formatTime(d);
    }
}
function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}
