pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function project_print()
 return ?"phase9",0,0,7
end
function _init()
 local value=project_print()
 poke(0x5000,type(value)=="number" and 1 or 0)
end
function _update() end
function _draw() end
