// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- USER SETUP ---
let myName = localStorage.getItem('deepSpaceUserName') || "Sarthak";
if (!localStorage.getItem('deepSpaceUserName')) {
    const input = prompt("Enter Name (Sarthak / Reechita):", "Sarthak");
    if(input) {
        myName = input.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}

// Normalize Names
const fixedDBName = (myName.toLowerCase().includes("sarthak")) ? "Sarthak" : "Reechita"; 
const fixedPartnerName = (fixedDBName === "Sarthak") ? "Reechita" : "Sarthak";

// References
const queueRef = db.ref('queue');
// We write to OUR sync node, Partner listens to IT.
const mySyncRef = db.ref(`users/${fixedDBName}/sync`);
const partnerSyncRef = db.ref(`users/${fixedPartnerName}/sync`);
const chatRef = db.ref('chat');

// --- GLOBAL VARIABLES ---
let player;
let currentQueue = [];
let currentVideoId = null;

// SYNC FLAGS
let isManualAction = false;    // True if I clicked a button (Play/Pause/Seek)
let ignoreUpdates = false;     // True while I am handling a remote command (prevents loops)
let isPartnerAdStall = false;  // True if partner is stuck in an Ad
let lastRemoteTimestamp = 0;   // To ignore old commands

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 1,           
            'disablekb': 0, 
            'modestbranding': 1,
            'rel': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    player.setVolume(70);
    loadFirebaseListeners();
    
    // Heartbeat: Check purely for Ad Stalls locally
    setInterval(checkLocalAdStall, 1000);
}

// ------------------------------------------------------------------------------------------------------
// --- CORE SYNCHRONIZATION LOGIC (THE FIX) ---
// ------------------------------------------------------------------------------------------------------

// 1. BROADCAST: Send my exact state to Firebase
function broadcastState(stateOverride = null) {
    if (!player || !currentVideoId || ignoreUpdates) return;

    const currentTime = player.getCurrentTime();
    const state = stateOverride !== null ? stateOverride : player.getPlayerState();

    // Timestamp is crucial for calculating latency
    const payload = {
        videoId: currentVideoId,
        time: currentTime,
        state: state,
        isAdStall: false, // Explicitly false here, handled by stall detector
        timestamp: Date.now() 
    };

    mySyncRef.set(payload);
}

// 2. RECEIVE: Handle Partner's state with Latency Compensation
function handleRemoteSync(data) {
    // A. Safety Checks
    if (!data || !player || ignoreUpdates) return;
    if (data.timestamp < lastRemoteTimestamp) return; // Ignore old packets
    lastRemoteTimestamp = data.timestamp;

    // B. Ad Stall Handling (Priority 1)
    if (data.isAdStall === true) {
        if (!isPartnerAdStall) {
            isPartnerAdStall = true;
            document.getElementById('syncOverlay').classList.add('active');
            if (player.getPlayerState() === YT.PlayerState.PLAYING) {
                player.pauseVideo(); // We pause out of respect
            }
        }
        return; // Stop here, do not sync time/play
    } else {
        // Partner is free
        if (isPartnerAdStall) {
            isPartnerAdStall = false;
            document.getElementById('syncOverlay').classList.remove('active');
        }
    }

    // C. Song Change
    if (data.videoId && data.videoId !== currentVideoId) {
        ignoreUpdates = true; // Don't broadcast while loading new song
        const song = currentQueue.find(s => s.videoId === data.videoId);
        loadAndPlayVideo(data.videoId, song ? song.title : "Synced Song", false); // false = don't broadcast load
        
        // Wait for load, then apply seek
        setTimeout(() => {
            player.seekTo(data.time);
            if (data.state === YT.PlayerState.PLAYING) player.playVideo();
            ignoreUpdates = false;
        }, 1000);
        return;
    }

    // D. TIME SYNC CALCULATION (Real-Time Fix)
    const now = Date.now();
    const networkLatency = (now - data.timestamp) / 1000; // Convert ms to seconds
    
    // If partner is playing, they have moved forward while the data traveled
    let targetTime = data.time;
    if (data.state === YT.PlayerState.PLAYING) {
        targetTime += networkLatency; 
    }

    const myTime = player.getCurrentTime();
    const timeDiff = Math.abs(myTime - targetTime);

    ignoreUpdates = true; // Start ignoring local events to prevent feedback loop

    // E. Apply State
    if (data.state === YT.PlayerState.PAUSED) {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
        // Strict seek on pause to ensure exact frame match
        if (timeDiff > 0.1) { 
            player.seekTo(targetTime, true);
        }
    } 
    else if (data.state === YT.PlayerState.PLAYING) {
        // Only seek if drift is noticeable (> 0.8s) to prevent audio stuttering
        // If it's a huge jump (seek), do it immediately
        if (timeDiff > 0.8) {
            player.seekTo(targetTime, true);
        }
        
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    }

    // Release lock after a moment
    setTimeout(() => { ignoreUpdates = false; }, 500);
}

// ------------------------------------------------------------------------------------------------------
// --- PLAYER EVENTS & AD DETECTION ---
// ------------------------------------------------------------------------------------------------------

function onPlayerStateChange(event) {
    const btn = document.getElementById('play-pause-btn');
    
    if (event.data === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        // Only broadcast if it was a user action or a natural event, not a sync reaction
        if (!ignoreUpdates) broadcastState(YT.PlayerState.PLAYING);
    } 
    else if (event.data === YT.PlayerState.PAUSED) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        if (!ignoreUpdates) {
            // Check if this is a manual pause or an Ad pause is tough via API
            // We assume manual if 'isManualAction' was set by click
            if (isManualAction) {
                broadcastState(YT.PlayerState.PAUSED);
            }
        }
    } 
    else if (event.data === YT.PlayerState.ENDED) {
        playNextSong();
    }
    
    isManualAction = false;
}

// Separate Ad Detector: Checks if time is frozen while state says "PLAYING"
let lastCheckTime = -1;
let stallCounter = 0;

function checkLocalAdStall() {
    if (!player || !player.getPlayerState) return;
    
    const state = player.getPlayerState();
    const currentTime = player.getCurrentTime();

    if (state === YT.PlayerState.PLAYING) {
        // If time hasn't moved for 1 second, but we are supposed to be playing...
        if (Math.abs(currentTime - lastCheckTime) < 0.05) {
            stallCounter++;
        } else {
            stallCounter = 0;
            // We are playing fine, ensure DB knows we aren't stalled
            if (stallCounter === 0) {
                 // Optional: Periodic sync heartbeat every 5s to fix long-term drift
                 if (Math.floor(Date.now() / 1000) % 5 === 0 && !ignoreUpdates) {
                     broadcastState();
                 }
            }
        }
        lastCheckTime = currentTime;

        // If stalled for 2+ seconds, it's an Ad or Buffer
        if (stallCounter >= 2) {
            console.log("Local Ad/Buffer Stall detected. notifying partner.");
            mySyncRef.update({ isAdStall: true });
        } else {
            // If we recover, clear the flag
            if(stallCounter === 0) {
                 // We don't constantly write 'false' to save bandwidth, 
                 // but handled in broadcastState calls usually.
            }
        }
    } else {
        stallCounter = 0;
    }
}

// ------------------------------------------------------------------------------------------------------
// --- CONTROLS ---
// ------------------------------------------------------------------------------------------------------

function togglePlayPause() {
    if (!player) return;
    isManualAction = true;
    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        broadcastState(YT.PlayerState.PAUSED);
    } else {
        if(isPartnerAdStall) {
            alert("Waiting for Partner to finish Ad!");
            return;
        }
        player.playVideo();
        broadcastState(YT.PlayerState.PLAYING);
    }
}

function loadAndPlayVideo(videoId, title, shouldBroadcast = true) {
    if(!player) return;
    currentVideoId = videoId;
    document.getElementById('current-song-title').textContent = title;
    
    player.loadVideoById(videoId);
    isManualAction = true;
    
    if (shouldBroadcast) {
        // Broadcast immediately that we changed the song
        mySyncRef.set({
            videoId: videoId,
            state: YT.PlayerState.PLAYING,
            time: 0,
            isAdStall: false,
            timestamp: Date.now()
        });
    }
    renderQueue(currentQueue);
}

// SEEK BAR LISTENER
document.getElementById('seekBar').addEventListener('change', function() {
    if (!player) return;
    const seekToSec = (player.getDuration() * this.value) / 100;
    isManualAction = true;
    player.seekTo(seekToSec, true);
    broadcastState(); // Broadcast the seek immediately
});

// Update Seek Bar UI Loop
setInterval(() => {
    if(player && player.getCurrentTime) {
        const time = player.getCurrentTime();
        const duration = player.getDuration();
        document.getElementById('current-time').innerText = formatTime(time);
        document.getElementById('duration').innerText = formatTime(duration);
        if(duration > 0) {
            const val = (time / duration) * 100;
            document.getElementById('seekBar').value = val;
            document.getElementById('seek-progress').style.width = val + "%";
        }
    }
}, 500);

function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0'+sec : sec}`;
}

// ------------------------------------------------------------------------------------------------------
// --- QUEUE & DRAG-AND-DROP ---
// ------------------------------------------------------------------------------------------------------

function loadFirebaseListeners() {
    // 1. Queue
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const queueData = snapshot.val();
        let fetchedQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                fetchedQueue.push({ ...queueData[key], key: key });
            });
        }
        fetchedQueue.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = fetchedQueue;
        renderQueue(currentQueue);
    });

    // 2. Partner Sync (The Listener)
    partnerSyncRef.on('value', (snapshot) => {
        handleRemoteSync(snapshot.val());
    });

    // 3. Chat
    chatRef.limitToLast(20).on('child_added', snapshot => {
        const msg = snapshot.val();
        addChatMessageToUI(msg);
    });
}

function renderQueue(queueArray) {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    
    if(queueArray.length === 0) {
        list.innerHTML = '<p class="empty-state">Queue is empty.</p>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.setAttribute('draggable', 'true');
        item.dataset.key = song.key; 

        item.innerHTML = `
            <i class="fa-solid fa-grip-vertical drag-handle"></i>
            <img src="${song.thumbnail}" class="thumb">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>${song.uploader}</p>
            </div>
            <button class="del-btn" onclick="removeFromQueue('${song.key}')"><i class="fa-solid fa-trash-can"></i></button>
        `;

        item.addEventListener('click', (e) => {
            if(!e.target.closest('.del-btn') && !e.target.closest('.drag-handle')) {
                loadAndPlayVideo(song.videoId, song.title);
            }
        });

        addDragEvents(item);
        list.appendChild(item);
    });
    
    document.getElementById('queue-count').textContent = queueArray.length;
}

function addDragEvents(item) {
    item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        updateQueueOrderInFirebase();
    });
    
    const list = document.getElementById('queue-list');
    list.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingItem = document.querySelector('.song-item.dragging');
        if(!draggingItem) return;
        const siblings = [...list.querySelectorAll('.song-item:not(.dragging)')];
        const nextSibling = siblings.find(sibling => {
            return e.clientY <= sibling.getBoundingClientRect().top + sibling.offsetHeight / 2;
        });
        list.insertBefore(draggingItem, nextSibling);
    });
}

function updateQueueOrderInFirebase() {
    const listItems = document.querySelectorAll('#queue-list .song-item');
    const updates = {};
    listItems.forEach((item, index) => {
        updates[`${item.dataset.key}/order`] = index;
    });
    queueRef.update(updates);
}

// ------------------------------------------------------------------------------------------------------
// --- HELPER FUNCTIONS ---
// ------------------------------------------------------------------------------------------------------

function playNextSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length];
    if(next) loadAndPlayVideo(next.videoId, next.title);
}

function playPrevSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const prev = currentQueue[(idx - 1 + currentQueue.length) % currentQueue.length];
    if(prev) loadAndPlayVideo(prev.videoId, prev.title);
}

function addToQueue(videoId, title, uploader, thumbnail) {
    const newOrder = currentQueue.length > 0 ? (currentQueue[currentQueue.length-1].order || 0) + 1 : 1;
    queueRef.push({ videoId, title, uploader, thumbnail, order: newOrder });
    if(!currentVideoId) loadAndPlayVideo(videoId, title);
    document.getElementById('tab-queue').click();
}

function removeFromQueue(key) {
    queueRef.child(key).remove();
}

async function handleSearch() {
    const query = document.getElementById('searchInput').value;
    if(!query) return;
    document.getElementById('tab-results').click();
    const list = document.getElementById('results-list');
    list.innerHTML = '<p class="empty-state">Searching...</p>';
    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        list.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="thumb">
                <div class="meta"><h4>${item.snippet.title}</h4><p>${item.snippet.channelTitle}</p></div>
                <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
            `;
            div.querySelector('.add-btn').onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { list.innerHTML = '<p class="empty-state">Error.</p>'; }
}

function addChatMessageToUI(msg) {
    const div = document.createElement('div');
    div.className = `chat-message ${msg.user === myName ? 'me' : 'partner'}`;
    div.innerHTML = `<strong>${msg.user}</strong>: ${msg.text}`;
    const container = document.getElementById('chat-messages');
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

document.getElementById('sendChatBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value = ''; }
});

document.getElementById('forcePlayBtn').addEventListener('click', () => {
    isPartnerAdStall = false;
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo();
});

// UI Event Listeners
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('next-btn').addEventListener('click', playNextSong);
document.getElementById('prev-btn').addEventListener('click', playPrevSong);
document.getElementById('search-btn').addEventListener('click', handleSearch);
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', e => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(x => x.classList.remove('active'));
    e.target.classList.add('active');
    document.getElementById(e.target.id.replace('tab-','')+'-list').classList.add('active');
}));
