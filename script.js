// --- CONFIGURATION & INITIALIZATION ---
// Note: Firebase configuration is loaded from index.html
const FIREBASE_REF = firebase.database().ref('room_state');
let player;
let isMaster = false;
let lastKnownContentTime = 0; 
let lastSkipCommandTime = 0; 
let queue = [];
let queueIndex = 0;
let myState = -1; 

// --- DOM ELEMENTS (UPDATED FOR NEW UI) ---
const dom = {
    // Player Components
    disc: document.getElementById('music-disc'),
    art: document.getElementById('album-art'),
    title: document.getElementById('current-song-title'),
    playBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    masterStatus: document.getElementById('master-status'),

    // Search and Queue
    searchInput: document.getElementById('searchInput'),
    resultsList: document.getElementById('results-list'),
    queueList: document.getElementById('queue-list'),
    queueCount: document.getElementById('queue-count'),

    // Overlays and Controls
    overlay: document.getElementById('syncOverlay'),
    syncStatusText: document.getElementById('syncStatusText'),
    sharedSkipButton: document.getElementById('sharedSkipButton'),
    masterToggle: document.getElementById('masterToggle'),
    volumeBar: document.getElementById('volume-bar')
};

// --- YOUTUBE API SETUP ---
function onYouTubeIframeAPIReady() {
    // Player is still loaded, but its container is hidden
    player = new YT.Player('player', {
        height: '0', // Minimal size as it's hidden
        width: '0', 
        videoId: 'bTqVqk7FSmY', 
        playerVars: {
            'playsinline': 1,
            'controls': 0, // No default controls since we use custom ones
            'rel': 0 
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    console.log("Player ready for Sarthak and Reechita!");
    
    // Initial setup
    player.setVolume(100);
    dom.volumeBar.value = 100;

    // Start sync listeners
    startFirebaseListener();
    
    // Start updating UI controls
    setInterval(updateProgress, 500);
}

function onPlayerStateChange(event) {
    myState = event.data;
    
    // If the song ends (State 0), move to the next one
    if (event.data === YT.PlayerState.ENDED && isMaster) { 
        playNext(); 
    }
    
    // If the Master player changes state, update Firebase
    if (isMaster) {
        FIREBASE_REF.child('status').set(event.data);
    }
}


// --- CORE SYNC AND AD SKIP LOGIC (Similar to before, adapted for new UI) ---

function toggleMasterStatus() {
    isMaster = !isMaster;
    if (isMaster) {
        dom.masterToggle.innerHTML = '<i class="fas fa-crown"></i> I AM THE MUSIC LEADER 👑';
        dom.masterToggle.style.backgroundColor = '#ff4d4d';
        sendMasterStatus(); 
        console.log("Sarthak is the Master! Sending the true timeline to Reechita.");
    } else {
        dom.masterToggle.innerHTML = '<i class="fas fa-crown"></i> Be The Music Leader';
        dom.masterToggle.style.backgroundColor = 'var(--accent-color)';
        console.log("Switched to Viewer mode. Following the music leader.");
    }
}

function sendMasterStatus() {
    if (!isMaster) return;

    const playerState = player.getPlayerState();
    const currentTime = player.getCurrentTime();
    
    // --- ZERO PROGRESS AD DETECTION ---
    if (playerState === YT.PlayerState.PLAYING) {
        if (Math.abs(currentTime - lastKnownContentTime) < 0.1) {
            FIREBASE_REF.child('ad_detected').set(true);
        } else {
            lastKnownContentTime = currentTime;
            FIREBASE_REF.child('ad_detected').set(false); 
        }
    } else if (playerState !== YT.PlayerState.PLAYING) {
        FIREBASE_REF.child('ad_detected').set(false);
    }

    FIREBASE_REF.update({
        playbackTime: currentTime,
        status: playerState,
    });

    setTimeout(sendMasterStatus, 500); 
}

let lastSkipCommandTime = 0; 
let currentVideoId = null;

function startFirebaseListener() {
    FIREBASE_REF.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return; 

        // Update local state from Firebase
        queue = data.queue || [];
        queueIndex = data.queueIndex || 0;
        const serverTime = data.playbackTime || 0;
        const serverStatus = data.status;
        const serverSkipCommand = data.skip_command_timestamp || 0;
        const adIsDetected = data.ad_detected || false;
        
        renderQueueUI();

        // Load correct video if needed
        if (queue.length > 0) {
            const song = queue[queueIndex];
            if (currentVideoId !== song.videoId) {
                player.loadVideoById(song.videoId);
                currentVideoId = song.videoId;
                dom.title.textContent = song.title;
                dom.art.style.backgroundImage = `url('${song.thumbnail}')`;
            }
        }
        
        // --- 1. HANDLE AD DETECTION UI ---
        if (adIsDetected) {
            dom.overlay.classList.add('active');
            dom.syncStatusText.textContent = "Oops! An interruption. Click the button to skip it together.";
            dom.sharedSkipButton.style.display = 'block';
        } else {
            dom.overlay.classList.remove('active');
            dom.sharedSkipButton.style.display = 'none';
        }

        // --- 2. HANDLE SHARED SKIP COMMAND ---
        if (serverSkipCommand > lastSkipCommandTime) {
            player.seekTo(serverTime + 1, true); 
            lastSkipCommandTime = serverSkipCommand; 
            FIREBASE_REF.child('ad_detected').set(false);
            dom.syncStatusText.textContent = "Perfectly synchronized! Back to the music. ❤️";
            return; 
        }
        
        // --- 3. HANDLE REGULAR PLAYBACK SYNC ---
        if (!isMaster) {
             // Sync play/pause state
            if (player.getPlayerState() !== serverStatus) {
                if (serverStatus === YT.PlayerState.PLAYING) {
                    player.playVideo();
                } else if (serverStatus === YT.PlayerState.PAUSED) {
                    player.pauseVideo();
                }
            }

            // Sync rotating disc animation
            if (serverStatus === YT.PlayerState.PLAYING) {
                dom.playBtn.innerHTML = '<i class="fas fa-pause"></i>';
                dom.disc.classList.remove('paused');
            } else {
                dom.playBtn.innerHTML = '<i class="fas fa-play"></i>';
                dom.disc.classList.add('paused');
            }

            // Correct time drift for viewers
            const currentTime = player.getCurrentTime();
            if (Math.abs(currentTime - serverTime) > 3) {
                player.seekTo(serverTime, true);
            }
        }
    });
}

function skipAdSynchronized() {
    FIREBASE_REF.child('skip_command_timestamp').set(Date.now());
    dom.syncStatusText.textContent = "🚀 Skip command sent! Synchronizing...";
    dom.overlay.classList.remove('active');
    dom.sharedSkipButton.style.display = 'none';
}


// --- PLAYER CONTROLS (Full Control for everyone) ---

function togglePlay() {
    if(queue.length === 0) return;
    const isPlaying = player.getPlayerState() === YT.PlayerState.PLAYING;

    // Local action provides smooth UX
    if (isPlaying) {
        player.pauseVideo();
    } else {
        player.playVideo();
    }

    // Network action syncs all players
    FIREBASE_REF.update({ 
        status: isPlaying ? YT.PlayerState.PAUSED : YT.PlayerState.PLAYING, 
        playbackTime: player.getCurrentTime(),
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    FIREBASE_REF.update({ playbackTime: newTime });
}

function playNext() {
    if (queueIndex < queue.length - 1) {
        FIREBASE_REF.update({ queueIndex: queueIndex + 1, status: YT.PlayerState.PLAYING, playbackTime: 0 });
    } else {
        FIREBASE_REF.update({ status: YT.PlayerState.PAUSED, playbackTime: 0 });
    }
}

function playPrev() {
    if (queueIndex > 0) {
        FIREBASE_REF.update({ queueIndex: queueIndex - 1, status: YT.PlayerState.PLAYING, playbackTime: 0 });
    } else {
        FIREBASE_REF.update({ status: YT.PlayerState.PLAYING, playbackTime: 0 }); // Restart current song
    }
}

function setVolume(volume) {
    player.setVolume(volume);
}


// --- QUEUE AND SEARCH ---

dom.searchInput.addEventListener('input', (e) => {
    const q = e.target.value;
    // NOTE: YOUTUBE API KEY is needed for this search function!
    // Since we are fixing the quota issue later, this remains conceptual for now.
    
    if (q.length > 2) {
        // Placeholder for future searchYouTube(q) implementation
        dom.resultsList.innerHTML = '<p class="empty-state">Searching... (API Key needed here)</p>';
    }
});

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { videoId: id, title: title, thumbnail: thumb }];
    const updates = { queue: newQueue };
    if (queue.length === 0) {
        updates.queueIndex = 0;
        updates.status = YT.PlayerState.PLAYING;
        updates.playbackTime = 0;
    }
    FIREBASE_REF.update(updates);
    dom.searchInput.value = '';
}

function renderQueueUI() {
    dom.queueCount.textContent = `${queue.length} Songs`;
    dom.queueList.innerHTML = '';
    if (queue.length === 0) { dom.queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song!</p>'; return; }
    
    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = 'song-item';
        if (idx === queueIndex) div.style.background = 'rgba(255, 153, 204, 0.15)'; // Highlight playing song
        
        div.innerHTML = `
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-meta">
                <h4>${song.title}</h4>
                <p style="font-size:11px; color:var(--primary-color)">${idx === queueIndex ? 'PLAYING NOW' : 'QUEUED'}</p>
            </div>
            <i class="fas fa-times" style="padding:10px; color:#ff4d4d" onclick="deleteSong(event, ${idx})"></i>
        `;
        
        div.onclick = (e) => { 
            // Click to change song
            if(!e.target.classList.contains('fa-times')) {
                FIREBASE_REF.update({ queueIndex: idx, status: YT.PlayerState.PLAYING, playbackTime: 0 });
            }
        };
        dom.queueList.appendChild(div);
    });
}

window.deleteSong = function(e, idx) {
    e.stopPropagation();
    const newQueue = [...queue];
    newQueue.splice(idx, 1);
    let newIdx = queueIndex;
    if (idx < queueIndex) newIdx--;
    FIREBASE_REF.update({ queue: newQueue, queueIndex: newIdx < 0 ? 0 : newIdx });
}

window.clearQueue = function() {
    if(confirm("Clear the entire queue?")) FIREBASE_REF.update({ queue: [], queueIndex: 0, status: YT.PlayerState.PAUSED });
}


// --- UI HELPERS ---

dom.seekBar.addEventListener('change', () => {
    if (!player) return;
    const d = player.getDuration();
    if (!d) return;
    const time = (dom.seekBar.value / 100) * d;
    
    player.seekTo(time, true);
    FIREBASE_REF.update({ playbackTime: time });
});

function updateProgress() {
    if (!player) return;
    const c = player.getCurrentTime();
    const d = player.getDuration();
    if(d) {
        dom.seekBar.value = (c / d) * 100;
        dom.curr.textContent = formatTime(c);
        dom.dur.textContent = formatTime(d);
    }
}

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}
