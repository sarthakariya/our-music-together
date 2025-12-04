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
let myState = -1; // -1 unstarted, 1 playing, 2 paused, 3 buffering

// Core Master/Ad Guard Variables
const deviceId = new Date().getTime();
const playerRef = database.ref('playerStatus/' + deviceId); 
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
    qCount: document.getElementById('queue-count')
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
    // Report my presence and ensure cleanup if I disconnect
    playerRef.onDisconnect().remove(); 
    playerRef.set({ id: deviceId, timestamp: firebase.database.ServerValue.TIMESTAMP });
    
    // Start reporting Master status and UI updates
    setInterval(sendMasterStatus, 500); 
    setInterval(updateProgress, 500);
    
    // Schedule maintenance
    setInterval(removeStalePlayers, 900000); 
}

function onPlayerStateChange(e) {
    myState = e.data;
    if (e.data === 0) playNext(); 
}

function updateFirebase(updates) {
    syncRef.update(updates);
}





// ================= CORE SYNC LOGIC =================

// MASTER: Pushes its current time and status (needed for the Ad Guard)
function sendMasterStatus() {
    // Only the Master sends its playback status
    if (!player || !isMaster || queue.length === 0) return;

    const state = player.getPlayerState();
    if (state === 1 || state === 2) { 
        updateFirebase({ 
            seekTime: player.getCurrentTime(),
            status: state === 1 ? 'play' : 'pause',
        });
    }
}

// Listener for all Firebase updates
function listenForSync() {
    syncRef.on('value', snap => {
        const data = snap.val();
        
        // Handle empty session / Master election
        if (!data || !data.master) {
            claimMasterRole();
        }

        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        masterId = data.master;
        
        // Determine Ad Guard role
        isMaster = (masterId === deviceId);

        renderQueueUI();
        syncPlayerState(data);
    });
}

// This function uses a transaction to ensure only one person can claim the role
function claimMasterRole() {
    syncRef.child('master').transaction((currentMaster) => {
        if (currentMaster === null || currentMaster === undefined) {
            return deviceId; // Claim master role
        }
        return; // Abort transaction if master already exists
    }, (error, committed, snapshot) => {
        if (committed) {
            console.log("[SYNC] Successfully claimed Master Role.");
        }
    });
}

// Function to check if the Master Ad Guard has left
function checkMasterPresence() {
    if (!isMaster && masterId) {
        database.ref('playerStatus/' + masterId).once('value', snapshot => {
            if (!snapshot.exists()) {
                console.warn("[SYNC] Current Master has left. Triggering new Master election.");
                // Set master to null, which triggers the transaction logic
                updateFirebase({ master: null }); 
            }
        });
    }
}

// Function to enforce the state across all players
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
        if (dom.art) {
            dom.art.style.backgroundImage = `url('${song.thumbnail}')`;
        }
    }

    // 2. AD GUARD CHECK (Only the Master runs this check)
    if (isMaster) {
        checkMasterLag();
    } else {
        // Viewers check if the Master is still alive
        checkMasterPresence();
        // Viewers clear their local shield state if the Master is healthy
        dom.overlay.classList.remove('active');
        if (lagUpdateInterval) { clearInterval(lagUpdateInterval); lagUpdateInterval = null; }
        lagStartTime = null;
    }
    
    // 3. FORCE TIME/STATUS SYNC (Applies to all players)
    
    // Only seek if the shield is not active AND the time difference is large
    if (!dom.overlay.classList.contains('active')) {
        if (Math.abs(player.getCurrentTime() - serverTime) > 4) {
            player.seekTo(serverTime, true);
        }
    }

    // Force play/pause
    if (serverStatus === 'play' && myState !== 1) {
        player.playVideo();
        if (dom.disc) {
            dom.disc.style.animationPlayState = 'running';
        }
    } else if (serverStatus === 'pause' && myState === 1) {
        player.pauseVideo();
        if (dom.disc) {
            dom.disc.style.animationPlayState = 'paused';
        }
    }
    
    // 4. Update play/pause button icon 
    if (serverStatus === 'play') {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    }
}





// MASTER AD GUARD FUNCTION: ONLY monitors the Master player's buffering state
function checkMasterLag() {
    // State 3 = Buffering/Ad. If Master is buffering, we assume it's an ad and freeze everyone.
    const isMasterStuck = player.getPlayerState() === 3; 

    if (isMasterStuck) {
        
        if (lagStartTime === null) {
            lagStartTime = Date.now();
            if (!lagUpdateInterval) {
                 lagUpdateInterval = setInterval(updateLagUI, 1000);
            }
        }
        const timeElapsed = Date.now() - lagStartTime;
        const timeLimit = 120000; 
        const secondsRemaining = Math.max(0, Math.floor((timeLimit - timeElapsed) / 1000));
        
        if (timeElapsed >= timeLimit) {
            console.log("[SYNC] Auto-resuming Master due to 2-minute timeout.");
            lagStartTime = null; 
            window.resumeSync();
            return;
        }

        dom.overlay.classList.add('active');
        dom.msg.innerText = "AD DETECTED / BUFFERING";
        
        if (dom.disc) {
            dom.disc.style.animationPlayState = 'paused';
        }
        const syncTimerEl = document.getElementById('sync-timer');
        if (syncTimerEl) {
            syncTimerEl.innerText = secondsRemaining;
        }

    } else {
        // Clear shield if Master is no longer stuck
        lagStartTime = null; 
        
        if (lagUpdateInterval) {
            clearInterval(lagUpdateInterval);
            lagUpdateInterval = null;
        }

        dom.overlay.classList.remove('active');
    }
}

// Function to clean up stale player references
function removeStalePlayers() {
    const STALE_TIMEOUT_MS = 900000; 
    const cutoff = Date.now() - STALE_TIMEOUT_MS;

    database.ref('playerStatus').once('value', snapshot => {
        snapshot.forEach(childSnap => {
            const partnerData = childSnap.val();
            const partnerId = childSnap.key;

            if (partnerData.timestamp < cutoff) {
                database.ref('playerStatus/' + partnerId).remove();
                if (partnerId === masterId) {
                     // Trigger a new master election
                     updateFirebase({ master: null });
                }
            }
        });
    });
}





// ================= COLLABORATIVE CONTROLS (FULL EQUAL CONTROL) =================

function updateLagUI() {
    if (lagStartTime) {
        const timeElapsed = Date.now() - lagStartTime;
        const secondsElapsed = Math.floor(timeElapsed / 1000);
        const lagStatusEl = document.getElementById('lag-status');
        if (lagStatusEl) {
            lagStatusEl.innerText = `Lag duration: ${secondsElapsed} seconds`;
        }
    }
}

// Manual "Skip Ad" / Force Play
window.resumeSync = function() {
    if (!player) return;

    if (lagUpdateInterval) {
        clearInterval(lagUpdateInterval);
        lagUpdateInterval = null;
    }
    lagStartTime = null;

    dom.overlay.classList.remove('active');
    
    // 1. Local action (smooth UI)
    player.playVideo(); 
    // 2. Network action (sync all players)
    updateFirebase({ 
        status: 'play', 
        seekTime: player.getCurrentTime() || 0,
    });
}

function togglePlay() {
    if(queue.length === 0) return;
    const isPlaying = player.getPlayerState() === 1;

    // 1. Local action (smooth UI)
    if (isPlaying) {
        player.pauseVideo();
        if (dom.disc) {
            dom.disc.style.animationPlayState = 'paused';
        }
    } else {
        player.playVideo();
        if (dom.disc) {
            dom.disc.style.animationPlayState = 'running';
        }
    }

    // 2. Network action (sync all players)
    updateFirebase({ 
        status: isPlaying ? 'pause' : 'play', 
        seekTime: player.getCurrentTime(),
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    
    // 1. Local action (smooth UI)
    player.seekTo(newTime, true);
    
    // 2. Network action (sync all players)
    updateFirebase({ seekTime: newTime });
}

function playNext() {
    if (queueIndex < queue.length - 1) {
        // Anyone can push the next song command
        updateFirebase({ queueIndex: queueIndex + 1, status: 'play', seekTime: 0 });
    } else {
        updateFirebase({ status: 'pause', seekTime: 0 });
    }
}

function playPrev() {
    if (queueIndex > 0) {
        // Anyone can push the previous song command
        updateFirebase({ queueIndex: queueIndex - 1, status: 'play', seekTime: 0 });
    } else {
        // Restart current song if at the beginning
        updateFirebase({ status: 'play', seekTime: 0 });
    }
}

// ================= QUEUE & SEARCH (Collaborative - Fully Unrestricted) =================

dom.search.addEventListener('input', (e) => {
    const q = e.target.value;
    
    // Handle URL pastes
    if (q.includes('youtu')) { 
        const id = q.split('v=')[1]?.split('&')[0] || q.split('/').pop();
        if(id) {
            addToQueue(id, "Shared Link", "https://img.youtube.com/vi/"+id+"/default.jpg");
        }
        return;
    }
    
    // Handle search terms
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
        const safeTitle = item.snippet.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        
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
                <p style="font-size:10px; color:#00cec9">${idx === queueIndex ? 'PLAYING NOW' : 'QUEUED'}</p>
            </div>
            <i class="fa-solid fa-xmark" style="padding:10px; color:#ff4757" onclick="window.deleteSong(event, ${idx})"></i>
        `;
        div.onclick = (e) => { 
            // Anyone can click to change song
            if(!e.target.classList.contains('fa-xmark')) {
                updateFirebase({ queueIndex: idx, status: 'play', seekTime: 0 });
            }
        };
        dom.qList.appendChild(div);
    });
}

window.deleteSong = function(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = queueIndex;
    if (idx < queueIndex) newIdx--;
    updateFirebase({ queue: newQueue, queueIndex: newIdx < 0 ? 0 : newIdx });
}

window.clearQueue = function() {
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

// UI HELPERS
dom.seekBar.addEventListener('change', () => {
    if (!player) return;
    const d = player.getDuration();
    if (!d) return;
    const time = (dom.seekBar.value / 100) * d;
    
    // 1. Local action
    player.seekTo(time, true);
    
    // 2. Network action
    updateFirebase({ seekTime: time });
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

