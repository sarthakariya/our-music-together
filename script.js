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
const syncRef = database.ref('session'); // Changed ref name to 'session' for better structure

// ================= GLOBAL STATE =================
let currentQueue = [];
let currentSongIndex = 0;
let player;

// ================= YOUTUBE PLAYER SETUP =================
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: 'M7lc1UVf-VE', 
        playerVars: { 'playsinline': 1, 'controls': 0, 'rel': 0 },
        events: { 
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange // Crucial for auto-play next song
        }
    });
}

function onPlayerReady(event) {
    listenForSync(); 
}

// Handler for when the current video finishes
function onPlayerStateChange(event) {
    if (event.data === 0) { // State 0 means ended
        playNextSong();
    }
}

function playNextSong() {
    // Only the user currently playing (the one whose browser triggered the 'ended' event) should update Firebase
    if (currentSongIndex < currentQueue.length - 1) {
        updateFirebaseState({
            queueIndex: currentSongIndex + 1,
            status: 'play'
        });
    } else {
        // Queue ended
        updateFirebaseState({
            status: 'pause'
        });
    }
}

// ================= FIREBASE SYNC FUNCTIONS =================

// Writes a subset of state to Firebase
function updateFirebaseState(updates) {
    syncRef.update(updates);
}

function listenForSync() {
    syncRef.on('value', (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            // Initialize the state if it doesn't exist
            updateFirebaseState({
                queue: [],
                queueIndex: 0,
                status: 'pause'
            });
            return;
        }

        currentQueue = data.queue || [];
        currentSongIndex = data.queueIndex || 0;

        renderQueue(); // Update UI for the queue list

        const currentSong = currentQueue[currentSongIndex];
        const statusText = document.getElementById('statusText');

        if (currentSong && player) {
            // Load the new video ID if it's different
            if (player.getVideoData().video_id !== currentSong.videoId) {
                player.loadVideoById(currentSong.videoId);
            }

            // Sync Play/Pause
            if (data.status === 'play') {
                player.playVideo();
                statusText.innerText = `Playing: ${currentSong.title} | Syncing with Reechita...`;
            } else if (data.status === 'pause') {
                player.pauseVideo();
                statusText.innerText = `Paused: ${currentSong.title}`;
            }
        } else {
            statusText.innerText = "Queue Empty. Search for music!";
        }
    });
}

// ================= SEARCH & QUEUE MANAGEMENT =================

function handleEnter(e) {
    if(e.key === 'Enter') searchYouTube();
}

// Function to add a song to the end of the queue
function addToQueue(videoId, title, thumbnail) {
    const newSong = { videoId, title, thumbnail, id: Date.now() }; // Use timestamp as unique ID

    const newQueue = [...currentQueue, newSong];
    
    updateFirebaseState({
        queue: newQueue
    });

    // If the queue was empty, start playing the first song
    if (currentQueue.length === 0) {
        updateFirebaseState({
            queueIndex: 0,
            status: 'play'
        });
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
            // Click to add to the queue!
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

// Function to play a song directly from the queue (on click)
function playSongFromQueue(index) {
    if (index >= 0 && index < currentQueue.length) {
        updateFirebaseState({
            queueIndex: index,
            status: 'play'
        });
    }
}

// Renders the draggable queue list
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
        item.ondblclick = () => playSongFromQueue(index); // Double-click to play

        item.innerHTML = `
            <span class="queue-index">${index + 1}</span>
            <div class="queue-info">${song.title}</div>
            <i class="fa-solid fa-play" style="color: ${index === currentSongIndex ? '#4CAF50' : '#888'}; font-size: 14px; cursor: pointer;"></i>
        `;
        container.appendChild(item);
    });

    // Re-initialize drag handlers every time the queue renders
    setupDragDrop();
}

// ================= DRAG AND DROP LOGIC =================

let draggedItem = null;

function setupDragDrop() {
    const items = document.querySelectorAll('.queue-item');
    const container = document.getElementById('queue-container');

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
    
    // Simple visual placeholder logic
    if (this !== draggedItem) {
        const rect = this.getBoundingClientRect();
        const midpoint = rect.y + rect.height / 2;
        const insertBefore = e.clientY < midpoint;

        // Remove placeholder from other elements
        document.querySelectorAll('.drag-placeholder').forEach(p => p.remove());

        const placeholder = document.createElement('div');
        placeholder.className = 'drag-placeholder';

        if (insertBefore) {
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
        let toIndex = parseInt(this.getAttribute('data-index'));
        
        // Adjust toIndex based on insertion point (placeholder position)
        const rect = this.getBoundingClientRect();
        const midpoint = rect.y + rect.height / 2;
        if (e.clientY > midpoint) {
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


// Function to perform the actual queue reordering in the global state and Firebase
function rearrangeQueue(fromIndex, toIndex) {
    const movedItem = currentQueue.splice(fromIndex, 1)[0];
    
    // Correct the 'toIndex' if we are moving the item backwards
    if (toIndex > fromIndex) toIndex--;

    currentQueue.splice(toIndex, 0, movedItem);

    let newCurrentIndex = currentSongIndex;
    
    // If the song playing was moved, update its index
    if (fromIndex === currentSongIndex) {
        newCurrentIndex = toIndex;
    } else if (fromIndex < currentSongIndex && toIndex >= currentSongIndex) {
        // Song moved from before to after the current song
        newCurrentIndex--;
    } else if (fromIndex > currentSongIndex && toIndex <= currentSongIndex) {
        // Song moved from after to before the current song
        newCurrentIndex++;
    }

    // Push the updated queue and index to Firebase
    updateFirebaseState({
        queue: currentQueue,
        queueIndex: newCurrentIndex
    });
}
