// --- CONFIGURATION ---
// Your Firebase Configuration (Provided by Sarthak)
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
// Your YouTube API Key (Provided by Sarthak)
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();
const syncRef = db.ref('sync');
const queueRef = db.ref('queue');
const chatRef = db.ref('chat');


// --- GLOBAL STATE ---
let player; // Holds the YouTube Player object
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isSeeking = false;
let isPartnerPlaying = false;
let myName = "Sarthak"; // Default user name


// --- YOUTUBE PLAYER FUNCTIONS ---

// Function called by the YouTube API once it's ready
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 0, 
            'disablekb': 1,
            'rel': 0,
            'showinfo': 0,
            'modestbranding': 1,
            'autoplay': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    // Set initial volume
    player.setVolume(70); 
    
    // Attach listener to volume bar
    document.getElementById('volume-bar').addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        player.setVolume(volume);
        document.getElementById('volume-progress').style.width = volume + '%';
    });

    // Attach listener to seek bar
    const seekBar = document.getElementById('seek-bar');
    seekBar.addEventListener('mousedown', () => { isSeeking = true; });
    seekBar.addEventListener('mouseup', (e) => {
        isSeeking = false;
        const newTime = (player.getDuration() * e.target.value) / 100;
        player.seekTo(newTime, true);
        broadcastState('seek', newTime);
    });
    seekBar.addEventListener('input', (e) => {
        const newTime = (player.getDuration() * e.target.value) / 100;
        updateTimeDisplay(newTime, player.getDuration());
    });
    
    // Start tracking playback time locally
    setInterval(updateLocalTime, 1000);

    // Initial data load after player is ready
    loadInitialData();
}

function updateLocalTime() {
    if (player && player.getPlayerState) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING && !isSeeking) {
            const currentTime = player.getCurrentTime();
            const duration = player.getDuration();
            updateTimeDisplay(currentTime, duration);
            
            // Update seek bar only if not currently seeking by user
            const seekPercentage = (currentTime / duration) * 100;
            const seekBar = document.getElementById('seek-bar');
            seekBar.value = seekPercentage;
            document.getElementById('seek-progress').style.width = seekPercentage + '%';
            
            // Check for near end of video to auto-play next song
            if (duration - currentTime < 1 && duration > 0) {
                playNextSong();
            }
        }
    }
}

function onPlayerStateChange(event) {
    // 1: Playing, 2: Paused, 3: Buffering, 0: Ended
    
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';

    if (event.data === YT.PlayerState.PLAYING) {
        // Only broadcast if the change wasn't triggered by a remote partner sync
        if (!isPartnerPlaying) {
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
        playPauseBtn.innerHTML = pauseIcon;
        document.getElementById('syncOverlay').classList.remove('active');
        isPartnerPlaying = false; 
        
    } else if (event.data === YT.PlayerState.PAUSED) {
        if (!isPartnerPlaying) {
            broadcastState('pause', player.getCurrentTime(), currentVideoId);
        }
        playPauseBtn.innerHTML = playIcon;
        isPartnerPlaying = false; 
        
    } else if (event.data === YT.PlayerState.BUFFERING) {
        // Optionally show the sync overlay on buffering if it takes too long
        // broadcastState('pause', player.getCurrentTime(), currentVideoId);
        
    } else if (event.data === YT.PlayerState.ENDED) {
        playPauseBtn.innerHTML = playIcon;
        playNextSong();
    }

    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED || state === -1) {
        // Load the first song if nothing is playing
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
}

// Function to load and play a video by ID, called when a song is clicked
function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        // Broadcast the new song to the partner
        broadcastState('play', player.getCurrentTime(), videoId);
        
        // Update current time display immediately (0:00)
        updateTimeDisplay(0, player.getDuration());
        
        // Re-render queue to highlight the playing song
        renderQueue(currentQueue, currentVideoId);
    }
}

function updateTimeDisplay(currentTime, duration) {
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        
        const pad = (num) => num.toString().padStart(2, '0');
        
        if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
        return `${m}:${pad(s)}`;
    };
    
    document.getElementById('current-time').textContent = formatTime(currentTime);
    document.getElementById('duration').textContent = formatTime(duration);
}

// --- QUEUE MANAGEMENT ---

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length;

    if (currentQueue.length > 0) {
        const nextSong = currentQueue[nextIndex];
        loadAndPlayVideo(nextSong.videoId, nextSong.title);
    } else {
        // Stop playback if queue is empty
        currentVideoId = null;
        if (player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;

    if (prevIndex < 0) {
        prevIndex = currentQueue.length - 1; // Loop to the end
    }

    if (currentQueue.length > 0) {
        const prevSong = currentQueue[prevIndex];
        loadAndPlayVideo(prevSong.videoId, prevSong.title);
    }
}

// Attach prev/next button listeners
document.getElementById('prev-btn').onclick = playPreviousSong;
document.getElementById('next-btn').onclick = playNextSong;

function addToQueue(videoId, title, uploader, thumbnail, event) {
    // Prevent the song-item click handler from firing if the button is clicked
    if (event) event.stopPropagation();
    
    const newSong = { videoId, title, uploader, thumbnail };
    
    // Push to the Firebase list (this will trigger the queueRef listener)
    queueRef.push(newSong)
        .then(() => {
            console.log("Song added to queue successfully.");
            // Switch back to queue tab after adding
            switchTab('queue');
        })
        .catch(error => {
            console.error("Error adding song to queue:", error);
        });
}

function removeFromQueue(videoId, event) {
    if (event) event.stopPropagation(); // Stop propagation for the button

    // Find the Firebase key for the song to remove
    const songToRemove = currentQueue.find(song => song.videoId === videoId);

    if (songToRemove && songToRemove.key) {
        queueRef.child(songToRemove.key).remove()
            .then(() => {
                console.log("Song removed from queue.");
                // If the removed song was the currently playing one, play next
                if (videoId === currentVideoId) {
                    playNextSong();
                }
            })
            .catch(error => {
                console.error("Error removing song:", error);
            });
    }
}

function clearQueue() {
    if (confirm("Are you sure you want to clear the entire queue?")) {
        queueRef.remove()
            .then(() => {
                currentVideoId = null;
                if (player.stopVideo) player.stopVideo();
                document.getElementById('current-song-title').textContent = "Queue Cleared";
                console.log("Queue cleared successfully.");
            })
            .catch(error => {
                console.error("Error clearing queue:", error);
            });
    }
}


// --- RENDERING VIEWS ---

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(list => list.classList.remove('active'));

    document.getElementById(`tab-${tabName}`).classList.add('active');
    document.getElementById(`${tabName}-list`).classList.add('active');
}

// Renders the Queue List from the currentQueue array
function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        
        // Add ONCLICK HANDLER to the item to make it playable
        // We use the 'key' property that we added during the Firebase load to ensure uniqueness
        item.setAttribute('onclick', `loadAndPlayVideo('${song.videoId}', '${song.title.replace(/'/g, "\\'")}')`);
        
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="del-btn" title="Remove from Queue" onclick="removeFromQueue('${song.videoId}', event)">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;
        queueList.appendChild(item);
    });

    document.getElementById('queue-count').textContent = queueArray.length;
    document.getElementById('total-queue-size').textContent = queueArray.length;
    // Scroll to the playing item if it exists
    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Renders the Search Results List
function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = ''; 

    if (resultsArray.length === 0) {
        resultsList.innerHTML = '<p class="empty-state">No search results found. Try a different query!</p>';
        return;
    }

    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        
        // Add button uses the addToQueue function
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', '${song.thumbnail}', event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultsList.appendChild(item);
    });
}


// --- YOUTUBE SEARCH ---

async function searchYouTube() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;

    // Show results tab and clearing previous results
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p class="empty-state">Searching...</p>';

    // NOTE: YOUTUBE_API_KEY is now correctly configured above.
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
             document.getElementById('results-list').innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error: ${data.error.message}. Check API quota or key permissions.</p>`;
             return;
        }

        currentSearchResults = data.items
            .filter(item => item.id.kind === 'youtube#video')
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        renderSearchResults(currentSearchResults);

    } catch (error) {
        console.error("YouTube Search Error:", error);
        document.getElementById('results-list').innerHTML = '<p class="empty-state" style="color: var(--text-error);">Failed to fetch search results. Check API Key/Network.</p>';
    }
}


// --- FIREBASE SYNC (REALTIME DATABASE) ---

function loadInitialData() {
    // 1. Queue Listener
    queueRef.on('value', (snapshot) => {
        const queueData = snapshot.val();
        currentQueue = [];
        if (queueData) {
            // Convert Firebase object to an array, storing the Firebase key
            Object.keys(queueData).forEach(key => {
                currentQueue.push({ ...queueData[key], key: key });
            });
        }
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync State Listener
    syncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        if (syncState && syncState.lastUpdater !== myName) {
            applyRemoteState(syncState);
        }
        updateSyncStatus();
    });

    // 3. Chat Listener
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function broadcastState(action, time, videoId = currentVideoId) {
    if (!videoId) return;

    syncRef.set({
        action: action, 
        time: time,
        videoId: videoId,
        lastUpdater: myName,
        timestamp: Date.now()
    }).catch(error => {
        console.error("Error broadcasting state:", error);
    });
}

function applyRemoteState(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; // Flag to prevent local player from re-broadcasting the received state
    
    if (state.videoId !== currentVideoId) {
        // Find the video title in the queue to update display
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        // Load new video and seek
        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        
        // Ensure the correct song is highlighted in the queue
        renderQueue(currentQueue, currentVideoId);

    } else {
        // Same video, just seeking/pausing
        if (player.getCurrentTime() < state.time - 2 || player.getCurrentTime() > state.time + 2) {
            player.seekTo(state.time, true);
        }
    }

    if (partnerIsPlaying) {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } else {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
}

function updateSyncStatus() {
    // Check connection quality, current state, etc., and update the header message
    // Simplified status update:
    const msgEl = document.getElementById('sync-status-msg');
    
    if (player && player.getPlayerState) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> **DEEP SYNC ACTIVE**`;
            msgEl.style.color = 'var(--primary)';
        } else if (state === YT.PlayerState.PAUSED) {
            msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> **PAUSED** (Sync Ready)`;
            msgEl.style.color = 'var(--text-dim)';
        } else if (state === YT.PlayerState.BUFFERING) {
            msgEl.innerHTML = `<i class="fa-solid fa-sync fa-spin"></i> **BUFFERING** (Awaiting Data)`;
            msgEl.style.color = 'var(--accent)';
        } else {
            msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> Initializing Deep Space Connection...`;
            msgEl.style.color = 'var(--text-dim)';
        }
    }
}

// --- CHAT FUNCTIONS ---

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    chatRef.push({
        user: myName,
        text: text,
        timestamp: Date.now()
    }).then(() => {
        input.value = ''; // Clear input
    }).catch(error => {
        console.error("Error sending message:", error);
    });
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const isMe = user === myName;
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    
    // Simple sanitization, though for real deployment, server-side is needed
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    msgDiv.innerHTML = `
        <strong>${user}:</strong> ${safeText}
        <small>${time}</small>
    `;
    
    chatMessages.appendChild(msgDiv);
    
    // Auto-scroll to the bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Allow sending message with Enter key
document.getElementById('chatInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});

function forceSyncResume() {
    // Force play and broadcast current state to overwrite partner's potential ad/buffer pause
    if (player) {
        player.playVideo();
        broadcastState('play', player.getCurrentTime(), currentVideoId);
    }
    document.getElementById('syncOverlay').classList.remove('active');
}
