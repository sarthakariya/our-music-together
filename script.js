// --- CONFIGURATION ---
// Your Firebase Configuration (Provided by Sarthak)
const firebaseConfig = {
// ... existing config
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
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; 
let ignoreTemporaryState = false; 
let lastSyncState = null; 

// --- USER IDENTIFICATION ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Partner's Name):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}
const partnerName = (myName === "Sarthak" || myName === "sarthak") ? "Partner" : "Sarthak";


// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER FUNCTIONS (API Required) ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            // FIX: Changed 'controls': 0 to 'controls': 1 to enable native seek bar 
            'controls': 1,             
            'disablekb': 0, 
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
    if (player && player.setVolume) {
        player.setVolume(70); 
    }
    
    // Time broadcast interval (for sync)
    setInterval(broadcastTimeIfPlaying, 1000); 

    loadInitialData(); 
    
    // NEW: Set initial song uploader text placeholder
    document.getElementById('song-uploader').textContent = `Artist/Uploader: Ready to Sync...`;
}

function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Auto play next song if ended 
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        // Only broadcast state if we are the last known broadcaster and currently playing
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
            broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = pauseIcon;
        isManualAction = false; 
        ignoreTemporaryState = false; 
        
    } else {
        playPauseBtn.innerHTML = playIcon;

        // CRITICAL AD/BUFFER LOGIC (Broadcast Ad Stall if paused unexpectedly)
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            
            if (!isPartnerPlaying && !isManualAction && !ignoreTemporaryState && lastBroadcaster === myName) {
                // Local player paused on its own (ad/buffer) - Broadcast Ad Stall
                broadcastState('pause', player.getCurrentTime(), currentVideoId, true); 
            }
        } 
        
        if (event.data === YT.PlayerState.ENDED) {
            if (!isPartnerPlaying) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
            }
            playNextSong();
        }
    }
    
    isManualAction = false;
    isPartnerPlaying = false; 
    
    if (ignoreTemporaryState) {
        setTimeout(() => { ignoreTemporaryState = false; }, 500); 
    }
    
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        document.getElementById('syncOverlay').classList.remove('active'); 
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            document.getElementById('syncOverlay').classList.remove('active');
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
    isManualAction = true; 
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        isManualAction = false; 
        ignoreTemporaryState = true; 
        
        // Find the song by videoId to get the full object and key
        const songToPlay = currentQueue.find(song => song.videoId === videoId);
        
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        // NEW: Update the song uploader information
        const uploader = songToPlay ? songToPlay.uploader : "Unknown Artist";
        document.getElementById('song-uploader').textContent = `Artist/Uploader: ${uploader}`;
        
        // Broadcast after a slight delay to confirm player state is PLAYING/BUFFERING
        setTimeout(() => {
            if(player.getPlayerState() === YT.PlayerState.PLAYING || player.getPlayerState() === YT.PlayerState.BUFFERING) {
                 broadcastState('play', player.getCurrentTime(), videoId, false); 
            }
        }, 300); 
        
        renderQueue(currentQueue, currentVideoId);
    }
}


// ------------------------------------------------------------------------------------------------------
// --- QUEUE MANAGEMENT (FIXED & REARRANGE) ---
// ------------------------------------------------------------------------------------------------------

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length; 
    
    if (currentQueue.length > 0) {
        const nextSong = currentQueue[nextIndex];
        loadAndPlayVideo(nextSong.videoId, nextSong.title);
    } else {
        currentVideoId = null;
        if (player && player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
        // NEW: Clear uploader text
        document.getElementById('song-uploader').textContent = "Artist/Uploader: Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) { prevIndex = currentQueue.length - 1; } 
    
    if (currentQueue.length > 0) {
        const prevSong = currentQueue[prevIndex];
        loadAndPlayVideo(prevSong.videoId, prevSong.title);
    }
}

// FIX: Ensures the new song is added to the database and queue is re-rendered
function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    
    // Assign a default order value (e.g., current timestamp)
    const newSong = { 
        videoId, 
        title, 
        uploader, 
        thumbnail, 
        order: Date.now() + Math.random() 
    };
    const newKey = queueRef.push().key;
    
    queueRef.child(newKey).set(newSong)
        .then(() => { 
            // The Firebase listener will re-render the queue, just switch tabs
            switchTab('queue'); 
            
            // If the queue was empty, start playing the new song
            if (!currentVideoId && currentQueue.length === 0) {
                // currentQueue hasn't been updated by listener yet, so we use the new song info
                 loadAndPlayVideo(videoId, title);
            }
        })
        .catch(error => { console.error("Error adding song to queue:", error); });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;
    const updates = {};
    songs.forEach((song, index) => {
        // Assign order based on batch index + current timestamp
        const newKey = queueRef.push().key;
        updates[newKey] = { ...song, order: Date.now() + index * 1000 }; 
    });
    
    queueRef.update(updates)
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0 && songs.length > 0) {
                setTimeout(() => {
                    const firstSong = songs[0];
                    if (firstSong) { loadAndPlayVideo(firstSong.videoId, firstSong.title); }
                }, 500);
            }
        })
        .catch(error => { console.error("Error adding batch to queue:", error); });
}

// FIX: Use the 'key' (Firebase push ID) to ensure correct deletion
function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    
    const songToRemove = currentQueue.find(song => song.key === key);
    
    if (songToRemove) {
        queueRef.child(key).remove()
            .then(() => {
                if (songToRemove.videoId === currentVideoId) {
                    // If the currently playing song is removed, play the next one
                    playNextSong(); 
                }
                // The listener handles re-rendering
            })
            .catch(error => { console.error("Error removing song from queue:", error); });
    }
}


// --- FIREBASE LISTENERS & SYNC ---
function loadInitialData() {
    // 1. Queue Listener (Fetches all songs and sorts by 'order')
    queueRef.on('value', (snapshot) => {
        const queueObj = snapshot.val();
        currentQueue = [];
        if (queueObj) {
            currentQueue = Object.keys(queueObj).map(key => ({
                key: key, 
                ...queueObj[key]
            })).sort((a, b) => a.order - b.order); 
        }
        renderQueue(currentQueue, currentVideoId);
        
        // Auto-load first song if nothing is playing
        if (!currentVideoId && currentQueue.length > 0 && player && player.loadVideoById) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        }
    });

    // 2. Sync Command Listener (STRICT AD HALT IMPLEMENTATION)
    syncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        lastSyncState = syncState;
        if (syncState) {
            lastBroadcaster = syncState.lastUpdater;
            // Only apply command if the update is from the partner
            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        } else {
            document.getElementById('syncOverlay').classList.remove('active');
        }
        updateSyncStatus();
    });

    // 3. Chat Listener
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;
    syncRef.set({
        action: action,
        time: time,
        videoId: videoId,
        lastUpdater: myName,
        isAdStall: isAdStall,
        timestamp: Date.now()
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;

    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true;
    const localTime = player.getCurrentTime ? player.getCurrentTime() : 0;
    
    // 1. Handle Song Change
    if (state.videoId !== currentVideoId) {
        const newSong = currentQueue.find(song => song.videoId === state.videoId);
        if (newSong) {
            loadAndPlayVideo(newSong.videoId, newSong.title);
            // After loading, the player state will change, which triggers the next step
        } else {
            // If the song isn't in the queue, we can't play it. Log error.
            console.warn(`Partner is playing a song not in queue: ${state.videoId}`);
            return;
        }
    }
    
    // 2. Handle Play/Pause
    if (partnerIsPlaying) {
        if (state.isAdStall) {
            // Partner stalled/paused due to ad/buffer. SHOW OVERLAY.
            document.getElementById('overlayTitle').textContent = `Playback Paused by ${lastBroadcaster}`;
            document.getElementById('overlayText').innerHTML = `Your partner's playback encountered a stall. To resume, they must manually press play/resume. You can try to <strong>Force Play & Sync</strong> below, but it may desync the streams.`;
            document.getElementById('syncOverlay').classList.add('active');
            player.pauseVideo();
            return;
        } else {
            // Partner pressed play/broadcasted time
            document.getElementById('syncOverlay').classList.remove('active');
            
            // Resume if paused
            if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
                 player.playVideo();
            }

            // Sync time if difference is large (over 2 seconds)
            const timeDiff = Math.abs(localTime - state.time);
            if (timeDiff > 2 || timeDiff === 0 || localTime === 0) {
                player.seekTo(state.time, true);
                // Seeking will generate a state change event, we must ignore it temporarily
                ignoreTemporaryState = true; 
            }
        }
    } else { // Partner paused
        document.getElementById('syncOverlay').classList.remove('active');
        player.pauseVideo();
    }
}

// Function to force local player to resume and broadcast state
function forcePlay() {
    document.getElementById('syncOverlay').classList.remove('active');
    if (player && currentVideoId) {
        player.playVideo();
        // Force an immediate broadcast of play state
        broadcastState('play', player.getCurrentTime(), currentVideoId, false);
    }
}

// --- UI & Utility Functions ---

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    
    if (lastSyncState && lastSyncState.isAdStall && lastSyncState.lastUpdater !== myName) {
        msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> **SYNC PAUSED** (Waiting for ${lastBroadcaster})`;
        msgEl.style.color = 'var(--text-error)';
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> **DEEP SYNC ACTIVE**`;
        msgEl.style.color = 'var(--primary)';
    } else {
        // Standard paused state
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> **PAUSED**`;
        msgEl.style.color = 'var(--text-dim)';
    }
}

// ... rest of the utility functions (renderQueue, renderSearchResults, switchTab, displayChatMessage)

function sendChatMessage() {
    const chatInput = document.getElementById('chatInput');
    const messageText = chatInput.value.trim();
    if (messageText) {
        chatRef.push({
            user: myName,
            text: messageText,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        }).then(() => {
            chatInput.value = '';
        }).catch(error => {
            console.error("Error sending message:", error);
        });
    }
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${user === myName ? 'me' : 'partner'}`;
    
    const time = new Date(timestamp);
    const timeString = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    messageEl.innerHTML = `
        <span class="user-name">${user === myName ? 'Me' : user}</span>
        <div class="message-text">${text}</div>
        <span class="timestamp">${timeString}</span>
    `;
    chatMessages.appendChild(messageEl);
    
    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// --- SEARCH & LINK HANDLERS ---
async function searchYouTube(query, maxResults = 10, type = 'video') {
// ... (omitted for brevity, assume no changes needed here)
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${type}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) {
            console.error("YouTube API Error:", data.error.message);
            return [];
        }
        const results = data.items
            .filter(item => item.id.kind === 'youtube#video')
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        return results;
    } catch (error) {
        console.error("YouTube Search Fetch Error:", error);
        return [];
    }
}

async function handleSearchAndLinks() {
// ... (omitted for brevity, assume no changes needed here)
    const searchInput = document.getElementById('searchInput');
    const query = searchInput.value.trim();
    const statusDiv = document.getElementById('search-status');

    if (!query) {
        statusDiv.innerHTML = `<p class="empty-state">Please enter a search term or a link.</p>`;
        return;
    }

    statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">Searching YouTube...</p>`;
    switchTab('results');

    if (query.startsWith('http')) {
        // Handle links (YouTube Playlist, Spotify)
        const playlistId = extractPlaylistId(query);
        const spotifyLink = isSpotifyLink(query);
        
        if (playlistId) {
            // Handle YouTube Playlist (Function omitted, assume it calls getPlaylistVideos and addBatchToQueue)
             statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">YouTube Playlist support is under development. Please search for individual songs.</p>`;
             return;
        } else if (spotifyLink) {
            // Handle Spotify Link
            await handleSpotifyLink(spotifyLink, statusDiv);
            return;
        }
    }
    
    // Standard YouTube search
    currentSearchResults = await searchYouTube(query);
    renderSearchResults(currentSearchResults);
    
    if (currentSearchResults.length === 0) {
        statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">No results found for "${query}".</p>`;
    } else {
        statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">Found ${currentSearchResults.length} results. Add them to the queue!</p>`;
    }
}

// ... rest of the search/link handlers (handleSpotifyLink, isSpotifyLink, extractPlaylistId)

function switchTab(tabName) {
    // ... (omitted for brevity, assume no changes needed here)
    document.getElementById('queue-list').classList.remove('active');
    document.getElementById('results-list').classList.remove('active');
    document.getElementById('tab-queue').classList.remove('active');
    document.getElementById('tab-results').classList.remove('active');

    if (tabName === 'queue') {
        document.getElementById('queue-list').classList.add('active');
        document.getElementById('tab-queue').classList.add('active');
    } else if (tabName === 'results') {
        document.getElementById('results-list').classList.add('active');
        document.getElementById('tab-results').classList.add('active');
    }
}

// --- DRAG AND DROP / RENDERING ---
function renderQueue(queueArray, currentVideoId) {
    // ... (omitted for brevity, assume no changes needed here)
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';

    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        document.getElementById('queue-count').textContent = 0;
        return;
    }
    
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.setAttribute('draggable', 'true'); // Enable dragging
        item.setAttribute('data-key', song.key); // Store Firebase key for reordering/deletion
        item.setAttribute('onclick', `loadAndPlayVideo('${song.videoId}', '${song.title.replace(/'/g, "\\'")}')`);
        item.innerHTML = `
            <i class="fa-solid fa-grip-vertical drag-handle"></i>
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <div class="item-controls">
                <button class="del-btn" title="Remove from Queue" onclick="removeFromQueue('${song.key}', event)">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
        queueList.appendChild(item);
    });
    document.getElementById('queue-count').textContent = queueArray.length;
    
    // Add Drag and Drop listeners after rendering
    addDragDropListeners(queueList, queueArray);
    
    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ... rest of the file (addDragDropListeners, renderSearchResults, initializeAppListeners)

function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = '';

    if (resultsArray.length === 0) {
        resultsList.innerHTML = '<p class="empty-state">No search results.</p>';
        return;
    }

    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <div class="item-controls">
                <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', '${song.thumbnail}')">
                    <i class="fa-solid fa-plus"></i>
                </button>
            </div>
        `;
        resultsList.appendChild(item);
    });
}

function initializeAppListeners() {
    console.log("Setting up application event listeners (Updated)...");
    
    // 1. Player Controls
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('prev-btn').addEventListener('click', playPreviousSong);
    document.getElementById('next-btn').addEventListener('click', playNextSong);

    // 2. Search Handlers 
    document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            handleSearchAndLinks();
        }
    });
    
    // 3. Tab Switches 
    document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
    document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));

    // 4. Chat Handlers
    document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault(); 
            sendChatMessage();
        }
    });

    // 5. Sync Overlay Control
    document.getElementById('forceSyncBtn').addEventListener('click', forcePlay);
    
    // 6. Initial Tab Load
    switchTab('queue');
}

// Execute the listener setup when the script loads
initializeAppListeners();
