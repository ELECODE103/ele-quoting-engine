HOW TO RUN THE INSTANT QUOTE APP
=================================

Windows users:

  1. Double-click "start-windows.bat"
  2. A black terminal window will open - this is normal!
  3. The first time you run it, it will install some things
     (this takes 1-2 minutes - just let it finish)
  4. Your browser will automatically open with the app

If the browser doesn't open on its own, open Chrome or
Edge and go to: http://localhost:3001


FIRST TIME SETUP
================

You need Node.js installed on your computer (free and safe).

  1. Go to https://nodejs.org
  2. Click the big green "LTS" download button
  3. Run the installer (just click Next through everything)
  4. Then double-click start-windows.bat

Don't worry - the launch script will tell you if Node.js
is missing and open the download page for you.


TO STOP THE APP
===============

Just close the black terminal window. That's it.


WHAT IS THIS APP?
=================

This is an instant quoting tool for sheet metal parts.
Upload STEP, STL, or IGES files and get:

  - Real geometry extraction (dimensions, area, holes, bends)
  - Design-for-manufacturability (DFM) analysis
  - Instant pricing with material, cutting, and finish costs
  - Volume discounts and lead time options
  - 3D part preview in the browser


TROUBLESHOOTING
===============

"Node.js is not installed"
  -> Go to https://nodejs.org, install it, then try again

"Something went wrong installing dependencies"
  -> Make sure you're connected to the internet and try again

The app won't load in the browser
  -> Make sure the black terminal window is still open
  -> Try going to http://localhost:3001 manually

Port already in use error
  -> Another program is using port 3000 or 3001
  -> Close other apps and try again, or restart your computer
