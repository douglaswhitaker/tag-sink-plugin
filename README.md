## TagSink

This is a plugin for Eagle to help me organize datasets for teaching statistics better. [Eagle](https://eagle.cool/) is a Digital Asset Manager (DAM) available for Windows and macOS; it is proprietary software but is available without a subscription (one-time purchase). Its core functionality was almost what I wanted for organizing datasets and related files for teaching, and it supports plugins to extend its functionality. With the current version of TagSink, I think that the core functionality that I was going for exists. 

### Features

**Goal**: Make a way to easily find an entire dataset (and all associated files) based on the tags applied to an individual file. 

For example, I want to identify datasets that I have tagged as being appropriate for multiple linear regression, or being from a randomized control trial, or have already used on an exam. Usual search features are challenging for this: if I applied a tag to the raw data file, then it isn't always easy to quickly locate the original journal article that I have saved, or assignments that I've used the dataset in. 

This plugin serves to: aggregate the tags of all files within a folder by adding them to a new file with the additional tag of "tag-sink" (user configurable tag name). This handles subdirectories, too. The way I use this is:

* Create a folder containing all files related to a dataset. 
* Apply tags to these files as appropriate (such as the type of methods that were used in the original paper, the methods I want to use them for, the types of variables, whether the dataset is small or large, whether it is a supplemental file but not the data or journal article, etc.).
* [Optional but recommended] Add an image to this folder that serves as visual representation of the dataset (tag as context-image; user configurable tag name). 
* Run the tag-sink plugin, which applies all tags to a copy of the file tagged context-image. 
* Create a Smart Folder for files tagged "tag-sink". This folder has one file per folder (the contex-image).
* Search in this Smart Folder for the tags I am interested in; the results are the folders whose datasets match. 
* Right click a relevant file and choose Open File Location to be taken to the correct folder. 

This system isn't perfect, but it has been helping me with organzing the large number of datasets that I use for teaching. 

The plugin also includes a small function to apply the file extension as a tag to files in the directory (so that "csv" and "sav" become searchable tags, for example). 

#### Limitations/Notes

The way Eagle works is by copying files to a library that it keeps organized (in its own way that doesn't reflect the folder structure used in the app). It is easy to copy files out of this library, and the library itself can be browsed with a bit of effort, but the design paradigm of copying all files to a library is perhaps not ideal. This is a core feature of Eagle, though, and it cannot be changed. 

### Current Release

Version 1.4.2 is the current release. This is a beta/pre-production release: I'm using this plugin now to organize my datasets, but I make no guarantees about it (see note below). Even if this plugin misbehaves in someway, I imagine that the consequences would be fairly minor (mostly related to tag aggregation in Eagle), but do not use this in any critical environments. 

### See Also

If you're interested in this plugin, there's a good chance you might also be interested in my other Eagle plugin which adds preview support for common data and code file types: [Data Preview](https://github.com/douglaswhitaker/data-preview-plugin)

### About Development

I am primarily a statistician and educator, not a web developer. To that end, I know neither JavaScript nor Node.js programming. As much as have serious misgivings about the use of generative AI (for the myriad reasons we all recognize), in the year 2026 I also believe that I have a responsibility as an educator to become familiar with the ways that generative AI tools are being used. This plugin is part of that professional development that I am doing: it is definitely 'vibe coding', as it were - but that's the way some things are built now. The prompts that I used for creating this are available in the `prompts` directory, and I intend to continue to periodically update this as more work is done.

This plugin was built primarily using ChatGPT (GPT-5.6 Luna), with some early work by Claude. 
