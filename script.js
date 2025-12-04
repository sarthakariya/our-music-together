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
const syncRef = database.ref('session'); // CRITICAL: This is the new reference for the queue

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
}

// Handler for when the current video finishes
function onPlayerStateChange(event) {
    if (event.data === 0) { // State 0 means ended
        playNextSong();
    }
}

function playNextSong() {
    if (currentSongIndex < currentQueue.length - 1) {
        updateFirebaseState({
            queueIndex: currentSongIndex + 1,
            status: 'play'
        });
    } else {
        updateFirebaseState({
            status: 'pause'
        });
    }
}

// ================= FIREBASE SYNC FUNCTIONS =================

// Writes a subset of state to Firebase
function updateFirebaseState(updates) {
    syncRef.update(updates).catch(error => {
        console.error("Firebase update failed:", error); 
        document.getElementById('statusText').innerText = "ERROR: Sync failed! Check database rules.";
    });
}

function listenForSync() {
    syncRef.on('value', (snapshot) => {
        const data = snapshot.val();
        
        if (!data || !data.queue) {
            // Initialize the state if it doesn't exist
            if (!data) {
                 updateFirebaseState({ queue: [], queueIndex: 0, status: 'pause' });
            }
            document.getElementById('statusText').innerText = "Queue Empty. Search for music!";
            renderQueue(); 
            return;
        }

        currentQueue = data.queue;
        currentSongIndex = data.queueIndex;

        renderQueue(); 

        const currentSong = currentQueue[currentSongIndex];
        const statusText = document.getElementById('statusText');

        if (currentSong && player) {
            // CRITICAL: Load the new video ID if it's different
            if (player.getVideoData().video_id !== currentSong.videoId) {
                player.loadVideoById(currentSong.videoId);
            }

            // CRITICAL: Sync Play/Pause status
            if (data.status === 'play') {
                player.playVideo();
                statusText.innerText = `Playing: ${currentSong.title} | Syncing with Reechita...`;
            } else if (data.status === 'pause') {
                player.pauseVideo();
                statusText.innerText = `Paused: ${currentSong.title}`;
            }
        }
    });
}

// ================= SEARCH & QUEUE MANAGEMENT =================

function handleEnter(e) {
    if(e.key === 'Enter') searchYouTube();
}

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

// Function to add a song to the end of the queue
function addToQueue(videoId, title, thumbnail) {
    const newSong = { videoId, title, thumbnail, id: Date.now() }; 
    const newQueue = [...currentQueue, newSong];
    
    let updates = { queue: newQueue };
    
    // If the queue was empty, start playing the first song
    if (currentQueue.length === 0) {
        updates.queueIndex = 0;
        updates.status = 'play';
    }
    
    updateFirebaseState(updates);
}

// Function to play a song directly from the queue (on double-click)
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

// ================= DRAG AND DROP LOGIC =================

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
        // Check if dropping on a placeholder
        if(targetElement.classList.contains('drag-placeholder')) {
             targetElement = targetElement.previousElementSibling || targetElement.nextElementSibling;
        }

        let toIndex = Array.from(targetElement.parentNode.children).indexOf(targetElement);
        
        // Check if we dropped below the midpoint, meaning we move AFTER the target
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


// Function to perform the actual queue reordering in the global state and Firebase
function rearrangeQueue(fromIndex, toIndex) {
    const newQueue = [...currentQueue];
    const movedItem = newQueue.splice(fromIndex, 1)[0];
    
    // Adjust toIndex based on insertion point
    if (toIndex > fromIndex) toIndex--;

    newQueue.splice(toIndex, 0, movedItem);

    let newCurrentIndex = currentSongIndex;
    
    // Logic to ensure the 'currently playing' index follows the song if it moves
    if (fromIndex === currentSongIndex) {
        newCurrentIndex = toIndex;
    } else if (fromIndex < currentSongIndex && toIndex > currentSongIndex) {
        newCurrentIndex--;
    } else if (fromIndex > currentSongIndex && toIndex <= currentSongIndex) {
        newCurrentIndex++;
    }

    // Push the updated queue and index to Firebase
    updateFirebaseState({
        queue: newQueue,
        queueIndex: newCurrentIndex
    });
}
