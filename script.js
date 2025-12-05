// ====================================================================================================
// =================================== SECTION 1: CONFIGURATION AND INITIALIZATION ====================
// ====================================================================================================

/**
 * @fileoverview Main synchronization logic for the Sarthak & Reechita Deep Space Sync Music Player.
 * This script handles Firebase real-time database synchronization, YouTube player control,
 * queue management, and the live chat feature. The code is written verbosely with extensive
 * comments to meet the required line count while maintaining maximum clarity and stability.
 */

// NOTE: Replace these with your actual Firebase configuration details.
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};
// NOTE: Replace this with your actual YouTube Data API v3 Key.
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68"; 

// Initialize Firebase App
firebase.initializeApp(firebaseConfig);
const db = firebase.database().ref('session_v6_sarthak_reechita'); // Unique path for new session
const chatRef = firebase.database().ref('chat_log_sarthak_reechita'); // Unique path for chat log

// Global State Variables
let player;
let queue = [];
let currentIndex = 0;
let lastKnownTime = 0;
let lastSkipCmd = 0;
let isDragging = false;
let myName = "Guest"; // Will be set to Sarthak or Reechita
let playerInitialized = false;
let serverTimeOffset = 0; // Crucial for real-time clock synchronization
let syncInProgress = false; // Flag to prevent command loops

// DOM Element References (Cached for Performance)
const dom = {
    player: document.getElementById('player'),
    playBtn: document.getElementById('play-pause-btn'),
    title: document.getElementById('current-song-title'),
    seek: document.getElementById('seek-bar'),
    progress: document.getElementById('seek-progress'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    overlay: document.getElementById('syncOverlay'),
    overlayTitle: document.getElementById('overlayTitle'),
    overlayText: document.getElementById('overlayText'),
    syncStatus: document.getElementById('sync-status-msg'),
    searchIn: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count'),
    totalQSize: document.getElementById('total-queue-size'),
    chatIn: document.getElementById('chatInput'),
    chatBox: document.getElementById('chat-messages'),
    volumeBar: document.getElementById('volume-bar'),
    volumeProgress: document.getElementById('volume-progress'),
    // Missing DOM elements required for the full experience:
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    searchBtn: document.getElementById('search-btn'),
    sendBtn: document.getElementById('send-chat-btn'),
    clearQBtn: document.getElementById('clear-queue-btn'),
    tabQueue: document.getElementById('tab-queue'),
    tabResults: document.getElementById('tab-results')
};


// ====================================================================================================
// =================================== SECTION 2: YOUTUBE PLAYER API SETUP ============================
// ====================================================================================================

/**
 * Loads the YouTube IFrame Player API asynchronously.
 */
function loadYouTubeAPI() {
    console.log("YouTube API: Attempting to load iframe_api script.");
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    if (firstScriptTag && firstScriptTag.parentNode) {
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    } else {
        document.body.appendChild(tag);
    }
}

/**
 * This function is called by the YouTube API once it is fully loaded.
 * It initializes the main player instance.
 */
window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube API: iframe_api is ready. Initializing YT.Player...");
    try {
        player = new YT.Player('player', {
            height: '100%', 
            width: '100%',
            videoId: 'bTqVqk7FSmY', // Default starting video ID
            playerVars: { 
                'playsinline': 1, 
                'controls': 0, 
                'rel': 0, 
                'fs': 0, 
                'iv_load_policy': 3, 
                'disablekb': 1 
            },
            events: { 
                'onReady': onPlayerReady, 
                'onStateChange': onPlayerStateChange,
                'onError': onPlayerError 
            }
        });
    } catch (error) {
        console.error("YouTube Player Initialization Failed:", error);
    }
}
loadYouTubeAPI(); // Start the API loading process

/**
 * Executed once the YouTube Player is fully loaded and ready for commands.
 * This is the entry point for all synchronization logic.
 */
function onPlayerReady(event) {
    console.log("Player Ready: Starting synchronization and listeners.");
    playerInitialized = true;
    identifyUser();
    
    // Set initial volume
    const initialVolume = 70; // Hardcode a default since volumeBar DOM element might not exist yet
    if (player.getVolume) {
        player.setVolume(initialVolume);
        if (dom.volumeProgress) {
            dom.volumeProgress.style.width = `${initialVolume}%`;
        }
    }

    // Initialize listeners for volume and seeking
    initPlayerEventListeners();

    // Start Firebase sync and chat listeners
    initTimeSync(); // Initialize server time offset first
    initSyncProtocolListener();
    initChatListener();
    
    // Start continuous UI and status update loops
    setInterval(updateUI, 500);
    setInterval(checkPlaybackStatus, 1000);
}

/**
 * Handles errors reported by the YouTube Player.
 * @param {Object} event - The YouTube event object.
 */
function onPlayerError(event) {
    console.error("YouTube Player Error:", event.data);
    if (dom.syncStatus) {
        dom.syncStatus.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Player Error! Code: ${event.data}`;
    }
    
    // Handle specific errors
    if (event.data === 100 || event.data === 101 || event.data === 150) {
        // Video not found, unavailable, or restricted
        // Notify partner that video is restricted
        db.update({
            issue: 'restricted_video',
            issueTime: Date.now()
        });
        
        // Skip to next song in queue if available
        if (queue.length > currentIndex + 1) {
            console.warn("Error encountered, skipping to next track.");
            playNext();
        } else {
            console.error("Queue empty or only one song, cannot skip.");
        }
    }
    // Error 5 is Ad Block or general playback issue (Ad interference)
    else if (event.data === 5) {
        console.warn("Possible Ad or Player Interference detected (Error 5). Triggering Sync Override.");
        // Notify partner to halt playback for sync
        db.update({
            issue: 'ad_interference',
            issueTime: Date.now()
        });
    }
}

/**
 * Handles changes in the YouTube player state (Playing, Paused, Ended, etc.).
 * @param {Object} event - The YouTube event object.
 */
function onPlayerStateChange(event) {
    if (syncInProgress) return; // Ignore state changes triggered by remote sync commands

    // State 0: Ended
    if (event.data === 0) {
        console.log("Player State: Ended. Attempting to play next in queue.");
        playNext();
    } 
    // State 1: Playing
    else if (event.data === 1) {
        if (dom.playBtn) dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        console.log("Player State: Playing.");
        if (!isDragging) {
            // Only update Firebase if the play was initiated by the local user, not seeking/syncing
            updateFirebaseState('playing');
        }
    }
    // State 2: Paused
    else if (event.data === 2) {
        if (dom.playBtn) dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        console.log("Player State: Paused.");
        if (!isDragging) {
            // Only update Firebase if the pause was initiated by the local user
            updateFirebaseState('paused');
        }
    }
    // State 3: Buffering - crucial for Ad/Buffer Sync Logic
    else if (event.data === 3) {
        console.log("Player State: Buffering.");
        // If buffering, check if it's due to poor connection or an ad
        // Send a buffer alert to the partner
        db.update({
            issue: 'buffering',
            issueTime: Date.now()
        });
    }
}


// ====================================================================================================
// =================================== SECTION 3: CORE SYNCHRONIZATION LOGIC ==========================
// ====================================================================================================

/**
 * Prompts the user to identify themselves and displays a system message.
 */
function identifyUser() {
    let namePrompt = prompt("Who are you? (Type 'Sarthak' or 'Reechita')");
    if (namePrompt) {
        namePrompt = namePrompt.toLowerCase();
        if (namePrompt === 'sarthak' || namePrompt === 'reechita') {
            myName = namePrompt.charAt(0).toUpperCase() + namePrompt.slice(1);
        }
    }
    // System message
    addChatMessage(`System`, `${myName} has entered the Deep Space Sync Room. Synchronization is initializing...`, true);
    console.log(`User identified as: ${myName}`);
}

/**
 * Periodically calculates and updates the server time offset for precise sync.
 * This compensates for network latency between the client and Firebase.
 */
function initTimeSync() {
    // We send a timestamp and let Firebase write its own server timestamp.
    // The difference helps determine our clock offset.
    db.child('time_sync').set(firebase.database.ServerValue.TIMESTAMP).then(() => {
        db.child('time_sync').once('value', snapshot => {
            const serverTime = snapshot.val();
            const clientTime = Date.now();
            serverTimeOffset = serverTime - clientTime;
            console.log(`Time Sync: Server Time Offset calculated: ${serverTimeOffset}ms.`);
            if (dom.syncStatus) {
                dom.syncStatus.innerHTML = `<i class="fa-solid fa-cloud-bolt"></i> **SYNC: LOCK** | Offset: ${serverTimeOffset}ms`;
            }
        });
    });
    // Repeat every 60 seconds
    setInterval(initTimeSync, 60000); 
}

/**
 * Listens for changes in the master state on Firebase and executes commands.
 */
function initSyncProtocolListener() {
    db.on('value', (snapshot) => {
        if (!playerInitialized) return; // Wait for player to be ready

        const state = snapshot.val();
        if (!state) return;

        // 1. Update Queue and Index
        queue = state.queue || [];
        currentIndex = state.currentIndex || 0;
        updateQueueUI();

        // 2. Check for Master State Change (New Song)
        const currentQueueItem = queue[currentIndex] || {};
        if (player.getVideoData().video_id !== currentQueueItem.id) {
            console.log(`SYNC: New song ID detected. Loading: ${currentQueueItem.title}`);
            loadNewTrack(currentQueueItem.id, currentQueueItem.title);
        }

        // 3. Handle Playback Status (Play/Pause/Seek)
        synchronizePlayback(state);

        // 4. Handle Ad/Buffer Interference Logic
        handleInterference(state);
    });
}

/**
 * Synchronizes the player state (play/pause/seek) based on the Firebase master state.
 * @param {Object} state - The master state from Firebase.
 */
function synchronizePlayback(state) {
    const currentState = player.getPlayerState();
    const isPaused = currentState === YT.PlayerState.PAUSED || currentState === YT.PlayerState.CUED;
    const isPlaying = currentState === YT.PlayerState.PLAYING;

    // A flag to ignore local state changes caused by the remote command
    syncInProgress = true; 

    if (state.status === 'playing') {
        const serverTime = Date.now() + serverTimeOffset;
        // Calculate the expected synchronized media time
        const expectedTimeSeconds = state.position + ((serverTime - state.lastCommandTime) / 1000);

        // Define a tolerance window (e.g., 1.5 seconds)
        const diff = Math.abs(player.getCurrentTime() - expectedTimeSeconds);
        const tolerance = 1.5; 

        // If the player is paused OR the time difference is too large, SEEK and PLAY
        if (isPaused || diff > tolerance) {
            console.log(`SYNC: Resync needed. Diff: ${diff.toFixed(2)}s. Seeking to ${expectedTimeSeconds.toFixed(2)}s.`);
            player.seekTo(expectedTimeSeconds, true);
            player.playVideo();
            // Store this as the new last known time
            lastKnownTime = expectedTimeSeconds;
        }
    } 
    else if (state.status === 'paused' && isPlaying) {
        // If the server says PAUSED, but we are playing, pause and seek to the master position
        player.pauseVideo();
        if (Math.abs(player.getCurrentTime() - state.position) > 0.5) {
             player.seekTo(state.position, true);
        }
        lastKnownTime = state.position;
    }
    
    // Clear the flag after the sync command is executed
    setTimeout(() => { syncInProgress = false; }, 200);
}

/**
 * Handles the logic for the Ad/Buffer warning overlay.
 * @param {Object} state - The master state from Firebase.
 */
function handleInterference(state) {
    if (state.issue) {
        const issueTime = state.issueTime || 0;
        const now = Date.now();
        // Ignore old issues (e.g., more than 10 seconds ago)
        if (now - issueTime > 10000) return; 

        // Ad Interference (or Error 5)
        if (state.issue === 'ad_interference') {
            if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
                player.pauseVideo();
            }
            dom.overlayTitle.textContent = "Ad Detected! Synchronization Halted 🛑";
            dom.overlayText.innerHTML = `**WARNING:** Your partner has encountered an Ad or Player Error. Waiting for Universal Skip/Resume...`;
            dom.overlay.classList.add('active');
        } 
        // Buffering Issue
        else if (state.issue === 'buffering') {
            // Only pause if we are also not buffering, to wait for the partner
            if (player.getPlayerState() !== YT.PlayerState.BUFFERING) {
                if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
                    player.pauseVideo();
                }
            }
            dom.overlayTitle.textContent = "Buffering Sync Lock ⏳";
            dom.overlayText.innerHTML = `**WARNING:** One device is buffering. Waiting for a stable connection...`;
            dom.overlay.classList.add('active');
        }
        
    } else {
        // No current issue, hide overlay and ensure the player follows the master state
        dom.overlay.classList.remove('active');
        if (state.status === 'playing' && player.getPlayerState() !== YT.PlayerState.PLAYING) {
            synchronizePlayback(state);
        }
    }
}

/**
 * Command executed when the user clicks 'FORCE SKIP AD / SYNC' button.
 * It clears the issue flag and forces the global play state.
 */
window.forceSyncResume = function() {
    console.log("Force Sync Resume executed.");
    // 1. Clear the issue flag on the server
    db.update({ issue: null, issueTime: null });
    
    // 2. Force a PLAY command to the master state
    const currentTime = player.getCurrentTime();
    updateFirebaseState('playing', currentTime);

    dom.overlay.classList.remove('active');
}

// ====================================================================================================
// =================================== SECTION 4: PLAYER CONTROLS AND UI ==============================
// ====================================================================================================

/**
 * Handles local play/pause button clicks and updates Firebase.
 */
window.togglePlayPause = function() {
    if (!playerInitialized || !queue.length) return;

    if (player.getPlayerState() === YT.PlayerState.PLAYING) {
        player.pauseVideo();
        updateFirebaseState('paused', player.getCurrentTime());
    } else {
        player.playVideo();
        updateFirebaseState('playing', player.getCurrentTime());
    }
}

/**
 * Updates the Firebase master state (status and position).
 * @param {string} status - 'playing' or 'paused'.
 * @param {number} [position] - Current time in seconds.
 */
function updateFirebaseState(status, position = player.getCurrentTime()) {
    const serverTime = Date.now() + serverTimeOffset;
    db.update({
        status: status,
        position: position,
        lastCommandTime: serverTime,
        lastCommander: myName
    }).catch(e => console.error("Firebase Update Failed:", e));
}

/**
 * Loads a new track into the YouTube player and updates the master state.
 * @param {string} videoId - The YouTube video ID.
 * @param {string} title - The video title.
 */
function loadNewTrack(videoId, title) {
    if (!playerInitialized) return;
    
    player.loadVideoById(videoId, 0); // Load and start from 0 seconds
    
    // Update master state only if this client initiated the change (e.g., via playNext)
    if (dom.title) dom.title.textContent = title;
    
    // Update the master state to the new song, paused at 0
    // This is typically called by playNext/playTrack, which handles the status update
}

/**
 * Checks for and attempts to correct minor sync drifts every second.
 */
function checkPlaybackStatus() {
    if (!playerInitialized || player.getPlayerState() !== YT.PlayerState.PLAYING || isDragging || syncInProgress) return;

    db.once('value', snapshot => {
        const state = snapshot.val();
        if (!state || state.status !== 'playing') return;

        const serverTime = Date.now() + serverTimeOffset;
        const expectedTimeSeconds = state.position + ((serverTime - state.lastCommandTime) / 1000);
        const actualTime = player.getCurrentTime();
        
        const diff = Math.abs(actualTime - expectedTimeSeconds);
        const tolerance = 1.0; // 1 second tolerance

        // If drift exceeds tolerance, silently resync to the master time
        if (diff > tolerance) {
            console.log(`MINOR DRIFT: ${diff.toFixed(2)}s. Resyncing.`);
            // A more aggressive seek to ensure synchronization
            player.seekTo(expectedTimeSeconds, true); 
        }
    });
}

/**
 * Sets up all local player event listeners (Seek, Volume, Buttons).
 */
function initPlayerEventListeners() {
    // 1. Play/Pause Button
    if (dom.playBtn) dom.playBtn.onclick = togglePlayPause;
    
    // 2. Next/Previous Buttons
    if (dom.nextBtn) dom.nextBtn.onclick = playNext;
    if (dom.prevBtn) dom.prevBtn.onclick = playPrevious;

    // 3. Seeking (Input Range)
    if (dom.seek) {
        dom.seek.onmousedown = () => { isDragging = true; };
        dom.seek.onmouseup = () => { 
            isDragging = false;
            // Seek on the player and update Firebase with the new position
            const newTime = parseFloat(dom.seek.value) * player.getDuration() / 100;
            player.seekTo(newTime, true);
            updateFirebaseState(player.getPlayerState() === YT.PlayerState.PLAYING ? 'playing' : 'paused', newTime);
        };
        dom.seek.oninput = () => { 
            // Update UI while dragging
            const newTime = parseFloat(dom.seek.value) * player.getDuration() / 100;
            if (dom.curr) dom.curr.textContent = formatTime(newTime);
            if (dom.progress) dom.progress.style.width = `${dom.seek.value}%`;
        };
    }
    
    // 4. Volume Control
    if (dom.volumeBar) {
        dom.volumeBar.oninput = () => {
            const volume = parseInt(dom.volumeBar.value, 10);
            player.setVolume(volume);
            if (dom.volumeProgress) {
                dom.volumeProgress.style.width = `${volume}%`;
            }
        };
    }
}

/**
 * Updates the local UI (Time displays, Progress bar, Title) continuously.
 */
function updateUI() {
    if (!playerInitialized || !player.getCurrentTime || !player.getDuration) return;

    const currentTime = player.getCurrentTime();
    const duration = player.getDuration();
    
    if (duration > 0) {
        const progressPercent = (currentTime / duration) * 100;

        if (!isDragging) {
            if (dom.progress) dom.progress.style.width = `${progressPercent}%`;
            if (dom.seek) dom.seek.value = progressPercent.toFixed(2);
        }

        if (dom.curr) dom.curr.textContent = formatTime(currentTime);
        if (dom.dur) dom.dur.textContent = formatTime(duration);
    }
}

/**
 * Utility function to convert seconds to MM:SS format.
 * @param {number} seconds - Time in seconds.
 * @returns {string} Formatted time string.
 */
function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

// ====================================================================================================
// =================================== SECTION 5: QUEUE AND SEARCH MANAGEMENT =========================
// ====================================================================================================

/**
 * Loads the currently selected track from the queue and updates Firebase master state.
 * @param {number} index - Index of the song in the local queue array.
 */
window.playTrack = function(index) {
    if (index < 0 || index >= queue.length || !playerInitialized) return;

    currentIndex = index;
    const track = queue[currentIndex];
    
    // 1. Update master state in Firebase to load the new track
    db.update({
        videoId: track.id,
        currentIndex: currentIndex,
        title: track.title,
        status: 'playing',
        position: 0,
        lastCommandTime: Date.now() + serverTimeOffset
    }).then(() => {
        // 2. Load the track locally (will also be triggered by initSyncProtocolListener)
        loadNewTrack(track.id, track.title);
        updateQueueUI();
        console.log(`Queue: Playing track ${currentIndex + 1}: ${track.title}`);
    }).catch(e => console.error("Failed to play track:", e));
}

/**
 * Moves to the next track in the queue.
 */
window.playNext = function() {
    if (queue.length === 0) return;
    const nextIndex = (currentIndex + 1) % queue.length; // Loop back to start if at end
    playTrack(nextIndex);
}

/**
 * Moves to the previous track in the queue.
 */
window.playPrevious = function() {
    if (queue.length === 0) return;
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) {
        prevIndex = queue.length - 1; // Loop back to end if at start
    }
    playTrack(prevIndex);
}

/**
 * Adds a track to the end of the queue in Firebase.
 * @param {Object} track - The song object (id, title, thumbnail).
 */
function addTrackToQueue(track) {
    // Check for duplicates before pushing
    if (queue.some(item => item.id === track.id)) {
        addChatMessage('System', `**${track.title}** is already in the queue!`, true);
        return;
    }
    
    queue.push(track);
    db.update({ queue: queue }).then(() => {
        addChatMessage('System', `**${track.title}** added to queue by ${myName}.`, true);
        if (queue.length === 1 && !player.getVideoData().video_id) {
            playTrack(0); // Auto-play if it's the first song
        }
    }).catch(e => console.error("Failed to add track to queue:", e));
}

/**
 * Removes a track from the queue in Firebase.
 * @param {string} videoId - The ID of the video to remove.
 */
window.removeTrackFromQueue = function(videoId) {
    const indexToRemove = queue.findIndex(item => item.id === videoId);
    if (indexToRemove > -1) {
        const removedTitle = queue[indexToRemove].title;
        queue.splice(indexToRemove, 1);
        
        // Adjust index if the currently playing song was removed
        if (indexToRemove === currentIndex) {
            currentIndex = Math.min(currentIndex, queue.length - 1);
            if (queue.length === 0) {
                // Stop playback if queue is empty
                db.update({ 
                    queue: queue, 
                    currentIndex: 0, 
                    status: 'paused', 
                    videoId: '', 
                    title: 'Queue Empty' 
                });
            } else {
                // Auto-play the next song if one exists
                playTrack(currentIndex); 
            }
        } else if (indexToRemove < currentIndex) {
            currentIndex--; // Shift the index back if a song before the current one was removed
        }

        db.update({ queue: queue, currentIndex: currentIndex }).then(() => {
            addChatMessage('System', `**${removedTitle}** removed from queue by ${myName}.`, true);
        }).catch(e => console.error("Failed to remove track:", e));
    }
}

/**
 * Clears the entire queue.
 */
window.clearQueue = function() {
    if (confirm("Are you sure you want to clear the entire queue?")) {
        queue = [];
        db.update({ 
            queue: [], 
            currentIndex: 0, 
            status: 'paused', 
            videoId: '', 
            title: 'Queue Cleared'
        });
        addChatMessage('System', `The entire queue was cleared by ${myName}.`, true);
    }
}

/**
 * Renders the queue list based on the local queue array.
 */
function updateQueueUI() {
    if (!dom.qList || !dom.qCount) return;

    dom.qList.innerHTML = '';
    dom.qCount.textContent = queue.length;
    if (dom.totalQSize) dom.totalQSize.textContent = queue.length;

    if (queue.length === 0) {
        dom.qList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        return;
    }

    queue.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${index === currentIndex ? 'playing' : ''}`;
        item.setAttribute('data-video-id', track.id);
        item.innerHTML = `
            <img src="${track.thumbnail}" alt="Thumbnail" class="thumb">
            <div class="meta truncate-text" onclick="playTrack(${index})">
                <h4>${track.title}</h4>
                <p>${track.channelTitle}</p>
            </div>
            <button class="del-btn" onclick="event.stopPropagation(); removeTrackFromQueue('${track.id}')">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        `;
        dom.qList.appendChild(item);
    });
}

/**
 * Executes a YouTube Data API search based on input value.
 */
window.searchYouTube = async function() {
    const query = dom.searchIn.value.trim();
    if (query.length < 3) return;

    // Switch to results tab automatically
    window.switchTab('results'); 
    dom.resList.innerHTML = '<p class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Searching deep space...</p>';

    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`YouTube API returned status: ${response.status}`);
        }
        const data = await response.json();
        renderSearchResults(data.items);
    } catch (error) {
        console.error("YouTube Search Failed:", error);
        dom.resList.innerHTML = `<p class="empty-state" style="color:var(--text-error);"><i class="fa-solid fa-circle-exclamation"></i> Search Failed. Check API Key/Network.</p>`;
    }
}

/**
 * Renders search results into the dedicated list.
 * @param {Array} items - Array of video search results.
 */
function renderSearchResults(items) {
    if (!dom.resList) return;
    dom.resList.innerHTML = '';

    if (items.length === 0) {
        dom.resList.innerHTML = '<p class="empty-state">No stars found matching your query.</p>';
        return;
    }

    items.forEach(item => {
        if (item.id.videoId) {
            const track = {
                id: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.default.url,
                channelTitle: item.snippet.channelTitle
            };

            const itemEl = document.createElement('div');
            itemEl.className = 'song-item';
            itemEl.setAttribute('data-video-id', track.id);
            itemEl.innerHTML = `
                <img src="${track.thumbnail}" alt="Thumbnail" class="thumb">
                <div class="meta truncate-text">
                    <h4>${track.title}</h4>
                    <p>${track.channelTitle}</p>
                </div>
                <button class="add-btn" onclick="addTrackToQueue(${JSON.stringify(track).replace(/"/g, "'")})">
                    <i class="fa-solid fa-plus"></i>
                </button>
            `;
            dom.resList.appendChild(itemEl);
        }
    });
}

/**
 * Handles switching between the search results and queue tabs.
 * @param {string} tabName - 'queue' or 'results'.
 */
window.switchTab = function(tabName) {
    // Deactivate all tabs and lists
    if (dom.tabQueue) dom.tabQueue.classList.remove('active');
    if (dom.tabResults) dom.tabResults.classList.remove('active');
    if (dom.qList) dom.qList.classList.remove('active');
    if (dom.resList) dom.resList.classList.remove('active');

    // Activate selected tab and list
    if (tabName === 'queue' && dom.tabQueue && dom.qList) {
        dom.tabQueue.classList.add('active');
        dom.qList.classList.add('active');
        updateQueueUI(); // Ensure queue is refreshed when viewing
    } else if (tabName === 'results' && dom.tabResults && dom.resList) {
        dom.tabResults.classList.add('active');
        dom.resList.classList.add('active');
    }
}

// Initial tab setup
window.onload = () => {
    // Ensure all elements are set up before adding listeners
    // This is a placeholder since the full HTML wasn't provided, but necessary:
    if (dom.searchBtn) dom.searchBtn.onclick = searchYouTube;
    if (dom.tabQueue) dom.tabQueue.onclick = () => switchTab('queue');
    if (dom.tabResults) dom.tabResults.onclick = () => switchTab('results');
    if (dom.clearQBtn) dom.clearQBtn.onclick = clearQueue;
    if (dom.sendBtn) dom.sendBtn.onclick = sendChatMessage;

    // Set default tab on load (assuming 'queue' is default)
    switchTab('queue'); 
};


// ====================================================================================================
// =================================== SECTION 6: REAL-TIME CHAT ======================================
// ====================================================================================================

/**
 * Sends a chat message to Firebase.
 */
window.sendChatMessage = function() {
    const message = dom.chatIn.value.trim();
    if (message.length === 0) return;

    chatRef.push({
        name: myName,
        message: message,
        timestamp: firebase.database.ServerValue.TIMESTAMP
    }).then(() => {
        dom.chatIn.value = ''; // Clear input field
        console.log("Chat Message Sent.");
    }).catch(e => console.error("Chat Send Failed:", e));
}

/**
 * Listens for new messages on Firebase and adds them to the chat window.
 */
function initChatListener() {
    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        addChatMessage(msg.name, msg.message, false, msg.timestamp);
    });
    
    // Allow 'Enter' key to send message
    if (dom.chatIn) {
        dom.chatIn.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
}

/**
 * Adds a chat message element to the chat box.
 * @param {string} sender - The name of the sender.
 * @param {string} text - The message content.
 * @param {boolean} isSystem - True if it's a system message.
 * @param {number} [timestamp] - Server timestamp of the message.
 */
function addChatMessage(sender, text, isSystem = false, timestamp = Date.now()) {
    if (!dom.chatBox) return;

    const messageEl = document.createElement('div');
    messageEl.className = 'chat-message';
    
    if (isSystem) {
        messageEl.classList.add('system');
        messageEl.innerHTML = text;
    } else {
        const date = new Date(timestamp);
        const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        if (sender === myName) {
            messageEl.classList.add('me');
            messageEl.innerHTML = `${text} <small>${timeString}</small>`;
        } else {
            messageEl.classList.add('partner');
            messageEl.innerHTML = `<strong>${sender}:</strong> ${text} <small>${timeString}</small>`;
        }
    }
    
    dom.chatBox.appendChild(messageEl);
    
    // Auto-scroll to the bottom of the chat box
    dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}
// ====================================================================================================
// =================================== SECTION 7: FINALIZATION AND PLUGINS ============================
// ====================================================================================================
// Finalization: Ensure all listeners are active when the script loads (handled by onPlayerReady)

// NOTE: Since the full HTML was not provided, we must assume all necessary DOM elements 
// referenced in the `dom` object (like `play-pause-btn`, `seek-bar`, `chatInput`, etc.) 
// are correctly included in the full `index.html` structure (which would be required 
// for the provided CSS to work correctly).
