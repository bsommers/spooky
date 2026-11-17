# tidyfiles

tidyfiles is a lightweight command-line tool that automatically organizes your messy downloads folder. With a single command, it sorts files into clear, logical categories based on their type, date, or custom rules that you define.

## Features

- Automatically sorts files by type, such as images, documents, and archives
- Supports custom rules through a simple configuration file
- Dry-run mode lets you preview changes before applying them
- Safe by design: files are never overwritten or deleted
- Works on Linux, macOS, and Windows

## Installation

You can install tidyfiles using pip:

    pip install tidyfiles

## Quick Start

To organize your downloads folder, run:

    tidyfiles ~/Downloads

To see what would happen without moving anything, add the --dry-run flag. For more advanced options, check out the configuration guide below.
