// ================= CONFIGURATION =================
// 1. YOUR FIREBASE CONFIG
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};

// 2. YOUR YOUTUBE DATA API KEY
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const syncRef = database.ref('session'); 

// ================= GLOBAL STATE & DOM =================
let currentQueue = [];
let currentSongIndex = 0;
let player;
let isSeeking = false; 

const dom = {
    playBtn: document.getElementById('play-btn'),
    pauseBtn: document.getElementById('pause-btn'),
    statusText: document.getElementById('statusText'),
    songDisplay: document.getElementById('current-song-display'),
    seekBar: document.getElementById('seek-bar'),
    currentTime: document.getElementById('current-time'),
    duration: document.getElementById('duration')
};

// ================= YOUTUBE PLAYER SETUP (Ad Fix Reinforcement) =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: 'M7lc1UVf-VE', 
        playerVars: { 
            'playsinline': 1, 
            'controls': 0, 
            'rel': 0, 
            'disablekb': 1,
            'fs': 0,
            'modestbranding': 1,
            'iv_load_policy': 3,
            'html5': 1, 
            'autoplay': 0 // Crucial: Never let YouTube control autoplay
        },
        events: { 
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange 
        }
    });
}

// Load YouTube API script
var tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
var firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

function onPlayerReady(event) {
    listenForSync(); 
    // Start updating the time display once the player is ready
    setInterval(updateTimeDisplay, 1000); 
}

function onPlayerStateChange(event) {
    if (event.data === 0) { // State 0 means ended
        playNextSong();
    } else if (event.data === 3) { // State 3 means buffering (often an ad)
        // CRITICAL AD FIX: If one device buffers (ads/latency), enforce sync
        syncRef.once('value').then(snapshot => {
            const data = snapshot.val();
            if (data && data.status === 'play') {
                // If Firebase says PLAY, but we are BUFFERING, enforce the current position.
                // This usually forces the player past the ad/buffer lag.
                if (data.seekTime) {
                   player.seekTo(data.seekTime, true);
                }
                player.playVideo();
                dom.statusText.innerText = `Re-syncing past lag/ad...`;
            }
        });
    }
}

function playNextSong() {
    if (currentSongIndex < currentQueue.length - 1) {
        updateFirebaseState({
            queueIndex: currentSongIndex + 1,
            status: 'play',
            seekTime: 0
        });
    } else {
        updateFirebaseState({
            status: 'pause'
        });
    }
}

// ================= TIME AND SEEK LOGIC =================

function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
}

function updateTimeDisplay() {
    if (!player || player.getPlayerState() === -1) return;

    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();

    dom.currentTime.textContent = formatTime(currentTime);
    dom.duration.textContent = formatTime(duration);

    if (!isSeeking) {
        const percentage = (currentTime / duration) * 100;
        dom.seekBar.value = percentage;
    }
}

function seekSync() {
    isSeeking = false;
    const duration = player.getDuration();
    const seekTime = (dom.seekBar.value / 100) * duration;
    
    // Set the state in Firebase for immediate sync
    updateFirebaseState({
        seekTime: Math.floor(seekTime),
        timestamp: Date.now() 
    });
}

function syncSeek(seconds) {
    const newTime = player.getCurrentTime() + seconds;

    updateFirebaseState({
        seekTime: Math.floor(newTime),
        timestamp: Date.now()
    });
}

// ================= FIREBASE SYNC FUNCTIONS (Reinforced) =================

function updateFirebaseState(updates) {
    syncRef.update(updates).catch(error => {
        console.error("Firebase update failed:", error); 
        dom.statusText.innerText = "ERROR: Sync failed! Check database rules.";
    });
}

// CRITICAL UNIVERSAL PLAY/PAUSE CONTROL
function syncAction(action) {
    updateFirebaseState({
        status: action,
        timestamp: Date.now() 
    });
}

function listenForSync() {
    syncRef.on('value', (snapshot) => {
        const data = snapshot.val();
        
        if (!data || !data.queue) {
            if (!data) { updateFirebaseState({ queue: [], queueIndex: 0, status: 'pause' }); }
            dom.statusText.innerText = "Queue Empty. Search for music!";
            dom.songDisplay.innerText = "No Song Selected";
            renderQueue(); 
            return;
        }

        currentQueue = data.queue;
        currentSongIndex = data.queueIndex;

        renderQueue(); 

        const currentSong = currentQueue[currentSongIndex];

        if (currentSong && player) {
            // 1. Load Video (Universal)
            if (player.getVideoData().video_id !== currentSong.videoId) {
                player.loadVideoById(currentSong.videoId);
                dom.songDisplay.innerText = currentSong.title;
            }

            // 2. Sync Play/Pause (Universal - Real-Time)
            if (data.status === 'play') {
                if (player.getPlayerState() !== 1) player.playVideo(); // 1 = playing
                dom.statusText.innerText = `Playing: ${currentSong.title} | Syncing with Reechita...`;
                dom.playBtn.style.display = 'none';
                dom.pauseBtn.style.display = 'block';
            } else { 
                if (player.getPlayerState() === 1) player.pauseVideo(); 
                dom.statusText.innerText = `Paused: ${currentSong.title}`;
                dom.playBtn.style.display = 'block';
                dom.pauseBtn.style.display = 'none';
            }
            
            // 3. Sync Seek Position (Universal - Only seek if needed)
            if (data.seekTime !== undefined && Math.abs(player.getCurrentTime() - data.seekTime) > 3) {
                 player.seekTo(data.seekTime, true);
                 dom.statusText.innerText = `Seeking to ${formatTime(data.seekTime)}...`;
            }
        }
    });
}

// ================= (REST OF SEARCH/QUEUE/DRAG LOGIC REMAINS BELOW) =================

async function searchYouTube() {
    const query = document.getElementById('searchInput').value;
    if (!query) return;

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${query}&type=video&key=${YOUTUBE_API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        displayResults(data.items);
    } catch (error) {
        console.error("Error searching:", error);
        document.getElementById('results-container').innerHTML = `<p style="color: #ff4d4d;">Search failed. Check your API key or quota!</p>`;
    }
}

function displayResults(videos) {
    const container = document.getElementById('results-container');
    container.innerHTML = ""; 

    videos.forEach(video => {
        const title = video.snippet.title;
        const thumbnail = video.snippet.thumbnails.default.url;
        const videoId = video.id.videoId;

        if (videoId) {
            const card = document.createElement('div');
            card.className = 'song-card';
            card.onclick = () => addToQueue(videoId, title, thumbnail); 

            card.innerHTML = `
                <img src="${thumbnail}" alt="thumb">
                <div class="song-info">
                    <h4>${title}</h4>
                    <p>Click to Add to Queue</p>
                </div>
            `;
            container.appendChild(card);
        }
    });
}

function addToQueue(videoId, title, thumbnail) {
    const newSong = { videoId, title, thumbnail, id: Date.now() }; 
    const newQueue = [...currentQueue, newSong];
    
    let updates = { queue: newQueue };
    
    if (currentQueue.length === 0) {
        updates.queueIndex = 0;
        updates.status = 'play';
        updates.seekTime = 0;
    }
    
    updateFirebaseState(updates);
}

function playSongFromQueue(index) {
    if (index >= 0 && index < currentQueue.length) {
        updateFirebaseState({
            queueIndex: index,
            status: 'play',
            seekTime: 0 
        });
    }
}

function renderQueue() {
    const container = document.getElementById('queue-container');
    container.innerHTML = '';
    
    if (currentQueue.length === 0) {
        container.innerHTML = `<p style="text-align: center; color: #999; padding-top: 50px;">Queue is empty. Search for a song!</p>`;
        return;
    }

    currentQueue.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `queue-item ${index === currentSongIndex ? 'currently-playing' : ''}`;
        item.draggable = true;
        item.setAttribute('data-index', index);
        item.ondblclick = () => playSongFromQueue(index); 

        item.innerHTML = `
            <span class="queue-index">${index + 1}</span>
            <div class="queue-info">${song.title}</div>
            <i class="fa-solid fa-play" style="color: ${index === currentSongIndex ? '#4CAF50' : '#888'}; font-size: 14px; cursor: pointer;"></i>
        `;
        container.appendChild(item);
    });

    setupDragDrop();
}

// --- DRAG AND DROP LOGIC (Unchanged and stable) ---

let draggedItem = null;

function setupDragDrop() {
    const items = document.querySelectorAll('.queue-item');

    items.forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('dragleave', handleDragLeave);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);
    });
}

function handleDragStart(e) {
    draggedItem = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', this.innerHTML);
    this.classList.add('dragging');
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (this !== draggedItem) {
        document.querySelectorAll('.drag-placeholder').forEach(p => p.remove());

        const placeholder = document.createElement('div');
        placeholder.className = 'drag-placeholder';

        const rect = this.getBoundingClientRect();
        const midpoint = rect.y + rect.height / 2;
        
        if (e.clientY < midpoint) {
            this.parentNode.insertBefore(placeholder, this);
        } else {
            this.parentNode.insertBefore(placeholder, this.nextSibling);
        }
    }
}

function handleDragLeave() {
    document.querySelectorAll('.drag-placeholder').forEach(p => p.remove());
}

function handleDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.drag-placeholder').forEach(p => p.remove());

    if (draggedItem !== this) {
        const fromIndex = parseInt(draggedItem.getAttribute('data-index'));
        
        let targetElement = this;
        if(targetElement.classList.contains('drag-placeholder')) {
             targetElement = targetElement.previousElementSibling || targetElement.nextElementSibling;
        }

        let toIndex = Array.from(targetElement.parentNode.children).indexOf(targetElement);
        
        const rect = targetElement.getBoundingClientRect();
        const midpoint = rect.y + rect.height / 2;
        if (e.clientY > midpoint && targetElement === this) {
            toIndex++; 
        }

        rearrangeQueue(fromIndex, toIndex);
    }
}

function handleDragEnd() {
    this.classList.remove('dragging');
    draggedItem = null;
    document.querySelectorAll('.drag-placeholder').forEach(p => p.remove());
}


function rearrangeQueue(fromIndex, toIndex) {
    const newQueue = [...currentQueue];
    const movedItem = newQueue.splice(fromIndex, 1)[0];
    
    if (toIndex > fromIndex) toIndex--;

    newQueue.splice(toIndex, 0, movedItem);

    let newCurrentIndex = currentSongIndex;
    
    if (fromIndex === currentSongIndex) {
        newCurrentIndex = toIndex;
    } else if (fromIndex < currentSongIndex && toIndex > currentSongIndex) {
        newCurrentIndex--;
    } else if (fromIndex > currentSongIndex && toIndex <= currentSongIndex) {
        newCurrentIndex++;
    }

    updateFirebaseState({
        queue: newQueue,
        queueIndex: newCurrentIndex
    });
}
