import { ImageDetails, DirectoryDetails } from "../../models/models"
import { IpcMainEvent } from "electron"

/**
 * Picture file & directory manipulation and retrieval service
 */
class FileService {
  private fs
  private db
  private config
  private slideShowService
  private rimraf
  private dialog
  private serverService
  private settingsService

  /**
   * @param db the database connection
   * @param config 
   * @param modules module imports from container
   * @param services service singletons from container
   */
  constructor(db, config, modules, services) {
    this.fs = modules.fs
    this.db = db
    this.config = config
    this.slideShowService = services.slideShowService
    this.rimraf = modules.rimraf
    this.dialog = modules.dialog
    this.serverService = services.serverService
    this.settingsService = services.settingsService
  }

  /**
   * Reads the user-provided directory and builds a list of image files present in it. 
   * @param directory The directory to read the contents from
   * @param entries The array of entries in the directory, which gets populated recursively
   * @returns the array of entries
   */
  readDirectory(directory: string, entries: Array<ImageDetails> = []) {
    let rootDirectory = this.settingsService.get('pictureDirectory')

    if (!directory) {
      directory = rootDirectory
    }

    const contents = this.fs.readdirSync(directory)

    contents.map((imageName) => {
      if (this.fs.existsSync(directory) &&  imageName[0] !== '.') {
        const fullPath = directory + '/' + imageName
        const stats = this.fs.statSync(fullPath)

        if (stats.isDirectory()) {
          this.readDirectory(fullPath, entries)
        } else if (stats.isFile()) {

          if (this.config.fileTypes.indexOf(imageName.split('.').pop().toLowerCase()) !== -1) {
            const entry = {
              imageName: imageName,
              directory: directory,
              relativeDirectory: directory.replace(rootDirectory, ''),
              shown: false,
              hidden: false,
              rotate: 0
            }

            entries.push(entry)
          }
        }
      }
    })

    return entries
  }

  /**
   * Scans the user provided directory for new or delated images
   * and updates the image database and image history with the changes 
   * @param event 
   */
  scan(event: IpcMainEvent = null) {
    const dir = this.settingsService.get('pictureDirectory')
    const fileDetails = this.readDirectory(dir)
    const updates = []
    const removals = []
    const entriesLookup = {}
    const fileDetailsLookup = {}
    const self = this

    this.db.find({}, ((err, entries) => {
      entries.forEach((entry) => {
        entriesLookup[entry.directory + entry.imageName] = entry
      })

      fileDetails.forEach((fileDetail) => {
        fileDetailsLookup[fileDetail.directory + fileDetail.imageName] = fileDetail

        if (!entriesLookup[fileDetail.directory + fileDetail.imageName]) {
          updates.push(fileDetail)
        }
      })

      entries.forEach((entry) => {
        if (!fileDetailsLookup[entry.directory + entry.imageName]) {
          removals.push(entry)
        }
      })

      self.db.insert(updates, ((err2) => {
        if (event && !removals.length) {
          event.sender.send('message', 'Scan complete!')
        }

        removals.forEach((removal, i) => {
          self.db.remove({ _id : removal._id }, ((err3) => {
            self.slideShowService.deleteFromHistory(removal)

            if (i !== removals.length - 1 || !event) {
              return
            }

            event.sender.send('message', 'Scan complete!')
          }))
        })
      }))
    }))
  }

  /** 
   * Gets the list of hidden files to display in the settings unhide page
   */
  getHiddenList(event: IpcMainEvent) {
    this.db.find({ hidden: true }).sort({ directory: 1 }).exec((err, entries) => {
      event.sender.send('sendHiddenList', entries)
    })
  }

  deleteDirectory(event: IpcMainEvent, imageDetails: ImageDetails) {
    const pictureDirectory = this.settingsService.get('pictureDirectory')

    if (imageDetails.directory.indexOf(pictureDirectory) === -1) {
      event.sender.send('message', 'You cannot delete a directory that is not part of the assigned picture directory')
      return
    }

    if (imageDetails.directory === pictureDirectory) {
      event.sender.send('message', 'You cannot delete the root picture folder!')
      return
    }

    this.slideShowService.stopShow()

    const self = this

    this.rimraf(imageDetails.directory, function () {
      self.db.remove({directory: imageDetails.directory}, { multi: true }, (() => {
        self.slideShowService.imageHistory.images = self.slideShowService.imageHistory.images.filter((e) => e.directory !== imageDetails.directory)
        self.slideShowService.imageHistory.position = self.slideShowService.imageHistory.images.length - 1

        event.sender.send('deleted', 'Deleted!')
      }))
    })
  }

  deleteImage(event: IpcMainEvent, imageDetails: ImageDetails) {
    this.slideShowService.stopShow()

    const self = this

    this.fs.unlink(imageDetails.directory + '/' + imageDetails.imageName, function(error) {
      if (error) {
        event.sender.send('message', 'Image not found!')
        return
      }

      self.db.remove({ _id : imageDetails._id }, (() => {
        self.slideShowService.deleteFromHistory(imageDetails)
        event.sender.send('deleted', 'Deleted!')
      }))
    })
  }

  /**
   * Hides an image by tagging it as hidden in the database 
   * @param event 
   * @param imageDetails 
   */
  hideImage(event: IpcMainEvent, imageDetails: ImageDetails) {
    this.slideShowService.stopShow()

    this.db.update( { _id: imageDetails._id}, { $set: { hidden: true } }, () => {
      this.slideShowService.deleteFromHistory(imageDetails)
      event.sender.send('hidden', 'Image hidden! You can unhide it from the settings/hidden menu.')
      this.slideShowService.next(event)
    })
  }

  /**
   * Hides all images in a directory by tagging them as hidden in the database 
   * @param event
   * @param imageDetails 
   */
  hideDirectory(event: IpcMainEvent, imageDetails: ImageDetails) {
    this.slideShowService.stopShow()

    const pictureDirectory = this.settingsService.get('pictureDirectory')

    if (imageDetails.directory.indexOf(pictureDirectory) === -1) {
      event.sender.send('message', 'You cannot hide a directory that is not part of the assigned picture directory')
      return
    }

    if (imageDetails.directory === pictureDirectory) {
      event.sender.send('hidden', 'You cannot hide the root picture folder!')
      return
    }

    const self = this

    this.db.update({ directory: imageDetails.directory }, { $set: { hidden: true } }, { multi: true }, (images => {
      self.slideShowService.imageHistory.images = self.slideShowService.imageHistory.images.filter((e) => e.directory !== imageDetails.directory)
      self.slideShowService.imageHistory.position = self.slideShowService.imageHistory.images.length - 1
      event.sender.send('hidden', 'Directory hidden! You can unhide it from the settings/hidden menu.')
      self.slideShowService.next(event)
    }))
  }

  /**
   * Toggle the hidden attribute of a file 
   * @param imageDetails
   */
  toggleHideFile(imageDetails: ImageDetails) {
    this.db.update( { _id: imageDetails._id}, { $set: { hidden: imageDetails.hidden } } )
  }

  /**
   * Show (unhide) all files in a directory
   * */
  showDirectory(directoryDetails: DirectoryDetails) {
    this.db.update( { directory: directoryDetails.directory }, { $set: { hidden: false } }, { multi: true } )
  }

  /**
   * Hides a bunch of files by their id
   * @param { string[] }ids the ids of the files to be hidden
   */
  hideFilesById(ids: Array<string>) {
    this.db.update( { _id: { $in: ids}}, { $set: { hidden: true }}, { multi: true } )
  }

  updateDetails(imageDetails: ImageDetails) {
    this.db.update( { _id: imageDetails._id }, { $set: imageDetails } )
  }

  /**
   * Prompts the user to pick the directory that contains their images
   * @param event 
   */
  async pickDirectory(event: IpcMainEvent) {
    // prompt the user to pick an image directory
    const dir = this.dialog.showOpenDialogSync({ properties: ['openDirectory'] })

    if (!dir) {
      return
    }

    this.slideShowService.stopShow()

    this.settingsService.set({ pictureDirectory: dir[0] })
    await this.serverService.startStaticFileServer(dir[0], this.config.defaults.expressJsPort)

    const self = this

    // delete all existing entries from the database and update it with the new ones
    this.db.remove({}, { multi: true }, function () {
      self.db.insert(self.readDirectory(dir[0]), ((err) => {
        event.sender.send('sendSettings', self.settingsService.get())
        self.slideShowService.start(event)
      }))
    })
  }
}

export { FileService }
