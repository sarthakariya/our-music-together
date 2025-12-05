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
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isSeeking = false;
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; // Flag to track explicit button clicks
let ignoreTemporaryState = false; // Debounce for video loading/quick buffer
// ----------------------------

// --- USER IDENTIFICATION ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Reechita):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}
const partnerName = (myName === "Sarthak") ? "Reechita" : "Sarthak";
// ----------------------------


// --- YOUTUBE PLAYER FUNCTIONS ---

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
    player.setVolume(70); 
    document.getElementById('volume-progress').style.width = '70%'; 
    
    // Attach listeners
    document.getElementById('volume-bar').addEventListener('input', (e) => {
        const volume = parseInt(e.target.value);
        player.setVolume(volume);
        document.getElementById('volume-progress').style.width = volume + '%';
    });

    const seekBar = document.getElementById('seek-bar');
    seekBar.addEventListener('mousedown', () => { isSeeking = true; });
    seekBar.addEventListener('mouseup', (e) => {
        isSeeking = false;
        const newTime = (player.getDuration() * e.target.value) / 100;
        player.seekTo(newTime, true);
        broadcastState('seek', newTime, currentVideoId, false); // Seek sync should not trigger ad mode
    });
    seekBar.addEventListener('input', (e) => {
        const newTime = (player.getDuration() * e.target.value) / 100;
        updateTimeDisplay(newTime, player.getDuration());
    });
    
    // Start tracking playback time locally (1-second interval)
    setInterval(updateLocalTime, 1000);

    loadInitialData();
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';
    
    // 1. Update visual button state
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = pauseIcon;
        isManualAction = false; 
        ignoreTemporaryState = false; 
        
    } else {
        playPauseBtn.innerHTML = playIcon;

        // CRITICAL AD/BUFFER LOGIC
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            // If the player PAUSED/BUFFERED and it was NOT from a remote command AND NOT from a local button click:
            if (!isPartnerPlaying && !isManualAction && !ignoreTemporaryState) {
                 // This is an Ad or deep Buffer stall. Broadcast pause to stop partner.
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, true); // Set isAd/Buffer flag to true
            }
        } 
        
        if (event.data === YT.PlayerState.ENDED) {
            if (!isPartnerPlaying) {
                 // Video ended locally, pause partner before playing next song
                 broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
            }
            playNextSong();
        }
    }
    
    // Always reset flags after processing state change
    isManualAction = false;
    isPartnerPlaying = false; 
    
    // Reset ignore flag after debounce period
    if (ignoreTemporaryState) {
        setTimeout(() => { ignoreTemporaryState = false; }, 500); 
    }
    
    updateSyncStatus();
}

function updateLocalTime() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Update local display and seek bar
        if (!isSeeking) {
            updateTimeDisplay(currentTime, duration);
            const seekPercentage = (currentTime / duration) * 100;
            document.getElementById('seek-bar').value = seekPercentage;
            document.getElementById('seek-progress').style.width = seekPercentage + '%';
        }
        
        // Check for near end of video to auto-play next song
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        // AGGRESSIVE 1-SECOND SYNC BROADCAST: Leader sends time updates
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
             broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;

    const state = player.getPlayerState();
    
    isManualAction = true; // Mark action as manual
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        // INSTANT SYNC: Broadcast PAUSE command, NOT an ad/buffer stall
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            // INSTANT SYNC: Broadcast PLAY command, NOT an ad/buffer stall
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        // Loading a new video is always a synchronization event
        isManualAction = false; 
        ignoreTemporaryState = true; // Temporary ignore during load/buffer phase
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        // Broadcast immediately to ensure partner loads the same video and starts playing
        broadcastState('play', player.getCurrentTime(), videoId, false); // Not an ad
        
        updateTimeDisplay(0, player.getDuration());
        renderQueue(currentQueue, currentVideoId);
    }
}

// --- FIREBASE SYNC (REALTIME DATABASE) ---

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;

    syncRef.set({
        action: action, 
        time: time,
        videoId: videoId,
        lastUpdater: myName, 
        isAdStall: isAdStall, // NEW: Flag to indicate if this is an ad/buffer forced pause
        timestamp: Date.now()
    }).catch(error => {
        console.error("Error broadcasting state:", error);
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; // Flag remote operation

    if (state.videoId !== currentVideoId) {
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        renderQueue(currentQueue, currentVideoId);
        
    } else if (state.action === 'seek') {
        player.seekTo(state.time, true);

    } else {
        const timeDiff = Math.abs(player.getCurrentTime() - state.time);
        if (timeDiff > 2) {
            player.seekTo(state.time, true);
        }
    }
    
    // Play/Pause Command Logic
    if (partnerIsPlaying) {
        // Always resume play
        document.getElementById('syncOverlay').classList.remove('active');
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } else {
        // Partner paused. Check the 'isAdStall' flag.
        if (state.isAdStall) {
             // If it's an ad stall, strictly lock the player until the partner resumes.
             document.getElementById('syncOverlay').classList.add('active');
        } else {
             // If it's a manual pause, just show the normal pause state (no lock)
             document.getElementById('syncOverlay').classList.remove('active');
        }
        
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
}

// ... (Rest of the functions: updateTimeDisplay, playNextSong, playPreviousSong, addToQueue, addBatchToQueue, removeFromQueue, clearQueue, renderQueue, renderSearchResults, switchTab, searchYouTube, extractPlaylistId, fetchPlaylist, updateSyncStatus, sendChatMessage, displayChatMessage)

// --- QUEUE MANAGEMENT ---

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length;

    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[nextIndex].videoId, currentQueue[nextIndex].title);
    } else {
        currentVideoId = null;
        if (player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;

    if (prevIndex < 0) {
        prevIndex = currentQueue.length - 1; 
    }

    if (currentQueue.length > 0) {
        loadAndPlayVideo(currentQueue[prevIndex].videoId, currentQueue[prevIndex].title);
    }
}

document.getElementById('prev-btn').onclick = playPreviousSong;
document.getElementById('next-btn').onclick = playNextSong;

function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    
    const newSong = { videoId, title, uploader, thumbnail };
    
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set(newSong)
        .then(() => {
            switchTab('queue');
        })
        .catch(error => {
            console.error("Error adding song to queue:", error);
        });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;

    const updates = {};
    songs.forEach(song => {
        const newKey = queueRef.push().key;
        updates[newKey] = song;
    });

    queueRef.update(updates)
        .then(() => {
            switchTab('queue');
            
            if (!currentVideoId && songs.length > 0) {
                setTimeout(() => {
                    if (currentQueue.length > 0) {
                         const firstSong = currentQueue.find(s => s.videoId === songs[0].videoId);
                         if (firstSong) {
                             loadAndPlayVideo(firstSong.videoId, firstSong.title);
                         }
                    }
                }, 500);
            }
        })
        .catch(error => {
            console.error("Error adding batch to queue:", error);
        });
}

function removeFromQueue(videoId, event) {
    if (event) event.stopPropagation();

    const songToRemove = currentQueue.find(song => song.videoId === currentVideoId);

    if (songToRemove && songToRemove.key) {
        queueRef.child(songToRemove.key).remove()
            .then(() => {
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

function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        document.getElementById('queue-count').textContent = 0;
        document.getElementById('total-queue-size').textContent = 0;
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        
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
    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

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


// --- YOUTUBE SEARCH & PLAYLIST PARSING ---

async function searchYouTube() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    const playlistId = extractPlaylistId(query);
    if (playlistId) {
        await fetchPlaylist(playlistId);
        inputElement.value = ''; 
        return;
    }

    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p class="empty-state">Searching...</p>';

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
             document.getElementById('results-list').innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error: ${data.error.message}</p>`;
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

function extractPlaylistId(url) {
    const regex = /[?&]list=([^&]+)/;
    const match = url.match(regex);
    if (match) {
        return match[1];
    }
    return null;
}

async function fetchPlaylist(playlistId, pageToken = null, allSongs = []) {
    switchTab('results');
    const statusDiv = document.getElementById('results-list');
    
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    
    try {
        statusDiv.innerHTML = `<p class="empty-state">Fetching playlist (Total songs: ${allSongs.length})... Please wait.</p>`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error fetching playlist: ${data.error.message}</p>`;
            return;
        }

        const newSongs = data.items
            .filter(item => item.snippet.resourceId.kind === 'youtube#video')
            .map(item => ({
                videoId: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        allSongs = allSongs.concat(newSongs);

        if (data.nextPageToken) {
            return await fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        } else {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Added ${allSongs.length} songs from playlist to the queue!</p>`;
            addBatchToQueue(allSongs);
            setTimeout(() => switchTab('queue'), 3000); 
        }

    } catch (error) {
        console.error("Playlist Fetch Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Failed to fetch playlist items. Check API Key/Network.</p>';
    }
}


// --- FIREBASE SYNC (REALTIME DATABASE) ---

function loadInitialData() {
    // 1. Queue Listener
    queueRef.on('value', (snapshot) => {
        const queueData = snapshot.val();
        currentQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                currentQueue.push({ ...queueData[key], key: key });
            });
        }
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync Command Listener
    syncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 

            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        }
        
        // Update overlay text if it's currently showing
        if (document.getElementById('syncOverlay').classList.contains('active')) {
             document.getElementById('overlayTitle').textContent = `Awaiting ${lastBroadcaster} to resume...`;
             document.getElementById('overlayText').innerHTML = `Playback paused due to a **${lastBroadcaster}** Ad/Buffer stall. You cannot resume playback until they do.`;
        }
        
        updateSyncStatus();
    });

    // 3. Chat Listener
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}


function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    
    if (document.getElementById('syncOverlay').classList.contains('active')) {
         msgEl.innerHTML = `<i class="fa-solid fa-sync fa-spin"></i> **AWAITING PARTNER** (Halted by ${lastBroadcaster})`;
         msgEl.style.color = 'var(--accent)';
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> **DEEP SYNC ACTIVE**`;
        msgEl.style.color = 'var(--primary)';
    } else {
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> **PAUSED**`;
        msgEl.style.color = 'var(--text-dim)';
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
    
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    msgDiv.innerHTML = `
        <strong>${user}:</strong> ${safeText}
        <small>${time}</small>
    `;
    
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

document.getElementById('chatInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        sendChatMessage();
    }
});
