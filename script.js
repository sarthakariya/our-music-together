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

// Normalize Names for DB paths
const fixedDBName = (myName.toLowerCase().includes("sarthak")) ? "Sarthak" : "Reechita"; 
const fixedPartnerName = (fixedDBName === "Sarthak") ? "Reechita" : "Sarthak";

// References
const queueRef = db.ref('queue');
const mySyncRef = db.ref(`users/${fixedDBName}/sync`);
const partnerSyncRef = db.ref(`users/${fixedPartnerName}/sync`);
const chatRef = db.ref('chat');

// --- GLOBAL VARIABLES ---
let player;
let currentQueue = [];
let currentVideoId = null;
let isManualAction = false; // Distinguishes user clicks from system pauses (ads)
let isPartnerAdStall = false;
let syncInterval = null;

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER & AD LOGIC ---
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
    // Heartbeat for Time Sync and Play Status
    syncInterval = setInterval(broadcastMyState, 1000);
    loadFirebaseListeners();
}

function broadcastMyState() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    const currentTime = player.getCurrentTime();
    
    // Auto-next logic
    if (state === YT.PlayerState.PLAYING && player.getDuration() > 0 && (player.getDuration() - currentTime < 1)) {
        playNextSong();
        return;
    }

    // Only broadcast if playing or paused (ignore buffering/unstarted for generic updates unless specific)
    if (currentVideoId) {
        mySyncRef.update({
            time: currentTime,
            state: state, // 1=Play, 2=Pause, 3=Buffer
            videoId: currentVideoId,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
    }
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        
        // I am playing successfully, so I am definitely NOT in an ad stall
        updateAdStallStatus(false); 
        
    } else {
        playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        // --- SMART AD DETECTION ---
        // If the state changed to PAUSED (2) or BUFFERING (3)
        // AND it was NOT caused by me clicking a button (isManualAction is false)
        // THEN it is likely an Ad or Network Buffer.
        if ((event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) && !isManualAction) {
            console.log("System Halt detected (Ad/Buffer). Broadcasting Stall.");
            updateAdStallStatus(true);
        } else if (event.data === YT.PlayerState.PAUSED && isManualAction) {
            // I paused it manually, that's fine. Not a stall.
            updateAdStallStatus(false);
        }
        
        if (event.data === YT.PlayerState.ENDED) {
            playNextSong();
        }
    }
    
    // Reset manual flag after handling the immediate state change
    setTimeout(() => { isManualAction = false; }, 500);
}

function updateAdStallStatus(isStalled) {
    mySyncRef.update({
        isAdStall: isStalled
    });
}

// ------------------------------------------------------------------------------------------------------
// --- SYNC & CONTROL LOGIC ---
// ------------------------------------------------------------------------------------------------------

function togglePlayPause() {
    if (!player) return;
    isManualAction = true; // Mark as user interaction

    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        // Explicitly tell partner I paused manually
        mySyncRef.update({ state: YT.PlayerState.PAUSED, isAdStall: false });
    } else {
        if(isPartnerAdStall) {
            alert("Cannot resume yet! Partner is watching an Ad.");
            return;
        }
        player.playVideo();
        mySyncRef.update({ state: YT.PlayerState.PLAYING, isAdStall: false });
    }
}

function loadAndPlayVideo(videoId, title) {
    if(!player) return;
    isManualAction = true;
    
    currentVideoId = videoId;
    document.getElementById('current-song-title').textContent = title;
    
    player.loadVideoById(videoId);
    
    mySyncRef.set({
        videoId: videoId,
        state: YT.PlayerState.PLAYING,
        time: 0,
        isAdStall: false,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    });
    
    renderQueue(currentQueue);
}

function loadFirebaseListeners() {
    // 1. Queue Listener
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

    // 2. Partner Sync Listener (THE CORE SYNC LOGIC)
    partnerSyncRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        // CHECK 1: Ad Stall Override
        if (data.isAdStall === true) {
            isPartnerAdStall = true;
            document.getElementById('syncOverlay').classList.add('active');
            if (player.getPlayerState() === YT.PlayerState.PLAYING) {
                isManualAction = true; // Prevent my pause from triggering a stall loop
                player.pauseVideo();
            }
            return; // Stop processing other sync commands while partner is stuck
        } else {
            // Partner is back! Remove overlay
            isPartnerAdStall = false;
            document.getElementById('syncOverlay').classList.remove('active');
        }

        // CHECK 2: Song Change
        if (data.videoId && data.videoId !== currentVideoId) {
            const song = currentQueue.find(s => s.videoId === data.videoId);
            loadAndPlayVideo(data.videoId, song ? song.title : "Synced Song");
            return;
        }

        // CHECK 3: Play/Pause State Match
        // Only react if I am not dragging the slider or doing something manual
        if (!isManualAction) {
            const myState = player.getPlayerState();
            
            if (data.state === YT.PlayerState.PLAYING && myState !== YT.PlayerState.PLAYING) {
                player.playVideo();
            } else if (data.state === YT.PlayerState.PAUSED && myState === YT.PlayerState.PLAYING) {
                player.pauseVideo();
            }
            
            // CHECK 4: Time Drift (Sync if > 2 seconds off)
            const myTime = player.getCurrentTime();
            if (Math.abs(data.time - myTime) > 2.5) {
                console.log("Resyncing time...");
                player.seekTo(data.time, true);
            }
        }
    });

    // 3. Chat
    chatRef.limitToLast(20).on('child_added', snapshot => {
        const msg = snapshot.val();
        addChatMessageToUI(msg);
    });
}

// ------------------------------------------------------------------------------------------------------
// --- QUEUE & DRAG-AND-DROP LOGIC (NEW) ---
// ------------------------------------------------------------------------------------------------------

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
        
        // DRAG ATTRIBUTES
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

        // Click to play (but ignore if clicking delete or drag handle)
        item.addEventListener('click', (e) => {
            if(!e.target.closest('.del-btn') && !e.target.closest('.drag-handle')) {
                loadAndPlayVideo(song.videoId, song.title);
            }
        });

        // Add Drag Events
        addDragEvents(item);
        
        list.appendChild(item);
    });

    document.getElementById('queue-count').textContent = queueArray.length;
}

// --- DRAG HANDLERS ---
function addDragEvents(item) {
    item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        // Store the key of the dragged item
        e.dataTransfer.setData('text/plain', item.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        updateQueueOrderInFirebase();
    });
    
    // Enable Drop Zone behavior on the list
    const list = document.getElementById('queue-list');
    list.addEventListener('dragover', (e) => {
        e.preventDefault(); // Necessary to allow dropping
        const draggingItem = document.querySelector('.song-item.dragging');
        if(!draggingItem) return;

        const siblings = [...list.querySelectorAll('.song-item:not(.dragging)')];
        
        // Find closest sibling based on mouse Y position
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
        const key = item.dataset.key;
        // Use the index as the new 'order' value (multiplied for spacing if needed)
        updates[`${key}/order`] = index;
    });

    queueRef.update(updates).catch(err => console.error("Reorder failed", err));
}

// ------------------------------------------------------------------------------------------------------
// --- HELPER FUNCTIONS (Search, Add, Chat) ---
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
    // Order is current timestamp, ensuring it goes to the end
    const newOrder = currentQueue.length > 0 ? (currentQueue[currentQueue.length-1].order || 0) + 1 : 1;
    
    queueRef.push({
        videoId, title, uploader, thumbnail,
        order: newOrder
    });
    
    if(!currentVideoId) loadAndPlayVideo(videoId, title);
    
    // Switch back to queue tab
    document.getElementById('tab-queue').click();
}

function removeFromQueue(key) {
    queueRef.child(key).remove();
}

// Force Resume Button (in case logic gets stuck)
document.getElementById('forcePlayBtn').addEventListener('click', () => {
    isManualAction = true;
    isPartnerAdStall = false; // Override local lock
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo();
});

// Search Logic
async function handleSearch() {
    const query = document.getElementById('searchInput').value;
    if(!query) return;
    
    document.getElementById('tab-results').click();
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = '<p class="empty-state">Searching...</p>';

    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        
        if(!data.items) {
             resultsList.innerHTML = '<p class="empty-state">No results found or API limit reached.</p>';
             return;
        }

        resultsList.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="thumb">
                <div class="meta">
                    <h4>${item.snippet.title}</h4>
                    <p>${item.snippet.channelTitle}</p>
                </div>
                <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
            `;
            div.querySelector('.add-btn').onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            resultsList.appendChild(div);
        });
    } catch(e) {
        console.error(e);
        resultsList.innerHTML = '<p class="empty-state">Error fetching results.</p>';
    }
}

// Chat UI
function addChatMessageToUI(msg) {
    const div = document.createElement('div');
    const isMe = msg.user === myName;
    div.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    div.innerHTML = `<strong>${msg.user}</strong>: ${msg.text}`;
    document.getElementById('chat-messages').appendChild(div);
    div.scrollIntoView();
}

document.getElementById('sendChatBtn').addEventListener('click', () => {
    const input = document.getElementById('chatInput');
    if(!input.value.trim()) return;
    chatRef.push({ user: myName, text: input.value.trim(), timestamp: Date.now() });
    input.value = '';
});

// Event Listeners for UI
document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('next-btn').addEventListener('click', playNextSong);
document.getElementById('prev-btn').addEventListener('click', playPrevSong);
document.getElementById('search-btn').addEventListener('click', handleSearch);

// Tab Switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.list-view').forEach(l => l.classList.remove('active'));
        
        e.target.classList.add('active');
        const id = e.target.id.replace('tab-', '');
        document.getElementById(`${id}-list`).classList.add('active');
    });
});
