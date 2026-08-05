pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
frame=0

function seed_text()
 poke(0x5f54,0xc0)
 poke(0x5f55,0xe0)
 memset(0xc000,0,0x2000)
 memset(0xe000,0,0x2000)

 poke(0x5600,4,8,6,0,0,3,8,0)
 poke(0x5600+97*8,7,5,7,5,5,0,0,0)
 poke(0x5600+98*8,3,5,3,5,3,0,0,0)
 sset(0,0,10)
 sset(1,0,11)
 memset(0x4340,0,0x40)
end

function _init()
 seed_text()
end

function _update60()
 frame+=1
 poke(0x4340,frame)
end

function _draw()
 cls(1)
 pal()
 pal(7,12)
 pal(1,129,1)
 spr(0,100,4)

 print(chr(2).."3"..chr(6).."w".."a"..chr(6).."-w",2,2,7)
 print(chr(14).."ab",2,16,8)
 print(chr(6)..":447cb67c3e7f0106",20,16,11)
 print(chr(6).."o801".."a",40,16,7)
 print(chr(6).."@43500004"..chr(10)..chr(11)..chr(12)..chr(13)..chr(0),0,-20,7)

 poke(0x4354,peek(0x4350),peek(0x4351),peek(0x4352),peek(0x4353))
 poke(0x4358,sget(0,0),sget(1,0),pget(2,2),peek(0xe000))
 local v={10,11,12,13,10,11,12,13}
 for i=1,#v do pset(i-1,120,v[i]) end

 pal(4,10)
 cursor(9,99,6)
 poke(0x5f58,0x81,0x64,0x24,0x11)
end
